let database = {}
module.exports = database
let common = require("./common")
let tiles = require("./tiles")
let units = require("./units")
let userstats = require("./userstats")
let Redis = require("ioredis")
let redis

//Prevents unnecessary writes during the same round to full simulation quotas
let fullSimCache = new Set()

const partitionSize = common.partitionSize

//Converts position list into a dict of slot friendly lists
//eg tile [5:7, 234:423] -> { 0 : [5:7...], 2 : [234:423...]}
function convertPositionList(positions) {
    let partitions = {}

    for (let pos of positions) {
        let partitionId = common.findPartitionId(pos)
        if (!partitions[partitionId]) partitions[partitionId] = []
        partitions[partitionId].push(pos)
    }

    return partitions
}

//Converts a unit list into a dict of slot friendly lists
//The dict key is the unit's owner id
function convertUnitList(unitList) {
    let batches = {}

    for (let unit of unitList) {
        if (!batches[unit.OwnerId]) batches[unit.OwnerId] = []
        batches[unit.OwnerId].push(unit)
    }

    return batches
}

function convertUnitIdList(unitIdList) {
    let batches = {}

    for (let id of unitIdList) {
        let ownerId = id.match(/\d+/)[0]
        if (!batches[ownerId]) batches[ownerId] = []
        batches[ownerId].push(id)
    }

    return batches
}

database.connect = () => {
    redis = new Redis.Cluster([{
        port: 6379,
        host: "redis.dev"
    }], {
        //scaleReads: "slave"
    })

    redis.on('ready', () => console.log("Database connected and ready."))

    return redis
}

database.disconnect = () => {
    redis.disconnect()
}

database.getTile = async (pos) => {
    return redis.hgetall("tile{"+common.findPartitionId(pos)+"}"+pos)
}

database.getTiles = async (positions) => {
    if (positions.length == 0) return []

    let partitions = convertPositionList(positions)
    let tileList = []
    let fetching = []

    for (let partitionId in partitions) {
        let pipeline = redis.pipeline()

        for (let pos of partitions[partitionId])
            pipeline.hgetall("tile{"+partitionId+"}"+pos, 
                (e, tile) => tile.Position && tileList.push(tiles.sanitise(tile)))

        fetching.push(pipeline.exec())
    }

    await Promise.all(fetching)
    return tileList
}

database.getTilesFromPartitions = async (partitionList) => {
    let tileList = []

    for (let partitionId of partitionList) {
        let [id, cache, list] = await database.getStaleTilesFromVersionCache(partitionId, "")
        tileList = tileList.concat(list)
    }

    return tileList
}

database.getStaleTilesFromVersionCache = async (partitionId, versionCache) => {
    let freshVersionCache = await redis.get("versionCache{" + partitionId + "}") || "0".repeat(partitionSize**2)

    //Exit early if given hash is valid (requestee already has up to date tiles)
    if (versionCache == freshVersionCache) return {}

    let hashes = versionCache.split("")
    let freshHashes = freshVersionCache.split("")
    let pipeline = redis.pipeline()
    let [xoffset, yoffset] = common.findXYFromPartitionId(partitionId)
    let tileList = []

    //Calculate the position of stale tiles and fetch them
    for (let i = 0; i < partitionSize**2; i++) {
        if (hashes[i] != freshHashes[i]) {
           
            let y = i % partitionSize
            let x = (i - y) / partitionSize
            //console.log(i, x, y, xoffset, yoffset)
            x += xoffset
            y += yoffset
            
            let grassTile = await tiles.newTile(tiles.TileType.GRASS, undefined, x+":"+y)

            pipeline.hgetall("tile{"+partitionId+"}"+x+":"+y, 
                (e, tile) => tile.Position ? tileList.push(tiles.sanitise(tile)) : tileList.push(grassTile))
        }
    }

    await pipeline.exec()
    return [partitionId, freshVersionCache, tileList]
}

//{partitionId: versionCache, ...} -> [[partitionId, versionCache, tiles], ...]
database.getStaleTilesFromPartitions = async (partitionDict) => {
    let updates = []

    for (let partitionId in partitionDict)
        updates.push(database.getStaleTilesFromVersionCache(partitionId, partitionDict[partitionId]))

    return await Promise.all(updates)
}

database.getUnit = async (ownerId, id) => {
    let unit = await redis.hgetall("unit{"+ownerId+"}"+id)

    if (!unit.Id) {
        redis.del("unit{"+ownerId+"}"+id)
        return null
    } else {
        return unit
    } 
}

// idDict = {ownerid: [id...], owner2id: [...
database.getUnits = async (idDict) => {
    let unitList = []
    let fetching = []

    for (let owner in idDict) {
        let pipeline = redis.pipeline()

        for (let id of idDict[owner])
            pipeline.hgetall("unit{"+owner+"}"+id, 
                (e, unit) => unit.Id && unitList.push(unit))

        fetching.push(pipeline.exec())
    }

    await Promise.all(fetching)
    return unitList
}

database.updateUnits = async (unitList, includeHealth = false) => {
    if (unitList.length == 0) return

    //Get unit batches by owner id
    let batches = convertUnitList(unitList)

    //Update unit data
    for (let owner in batches) {
        let pipeline = redis.pipeline()

        for (let unit of batches[owner]) {
            let health = unit.Health

            if (!includeHealth)
                delete unit.Health

            pipeline.hmset("unit{"+owner+"}"+unit.Id, unit)
            unit.Health = health
        }

        pipeline.exec()
    }

    //Update unit cache data
    let pipelines = {}

    for (let owner in batches){
        for (let unit of batches[owner]) {
            const partitionId = String(common.findPartitionId(unit.Position))
            const updateableState = unit.State != units.UnitState.DEAD && unit.State != units.UnitState.MOVING

            if (!pipelines[partitionId]) 
                pipelines[partitionId] = redis.pipeline()

            if (units.isMilitary(unit) && updateableState)
                pipelines[partitionId].hset("militaryUnitCache{"+partitionId+"}", owner+":"+unit.Id, unit.Position)

            pipelines[partitionId].hset("unitCache{"+partitionId+"}", owner+":"+unit.Id, unit.Position)

            if (partitionId != unit.PartitionId) {
                if (!pipelines[unit.PartitionId]) 
                    pipelines[unit.PartitionId] = redis.pipeline()

                if (units.isMilitary(unit))
                    pipelines[unit.PartitionId].hdel("militaryUnitCache{"+unit.PartitionId+"}", owner+":"+unit.Id)

                pipelines[unit.PartitionId].hdel("unitCache{"+unit.PartitionId+"}", owner+":"+unit.Id)
                redis.hset("unit{"+owner+"}"+unit.Id, "PartitionId", partitionId)
            }

            if (units.isMilitary(unit) && !updateableState) {
                pipelines[partitionId].hdel("militaryUnitCache{"+partitionId+"}", owner+":"+unit.Id)
            }
        }
    }

    let processing = []

    for (let partitionId in pipelines)
        processing.push(pipelines[partitionId].exec())

    await Promise.all(processing)
}

database.updateUnit = async (unit, includeHealth = false) => {
    /*let partitionId = common.findPartitionId(unit.Position)
    let health = unit.Health
    delete unit.Health

    if (includeHealth)
        unit.Health = health

    if (partitionId != unit.PartitionId)
        redis.hdel("unitCache{"+unit.PartitionId+"}", unit.OwnerId+":"+unit.Id)

    let commands = [
        redis.hmset("unit{"+unit.OwnerId+"}"+unit.Id, unit),
        redis.hset("unit{"+ unit.OwnerId+"}"+unit.Id, "PartitionId", partitionId),
        redis.hset("unitCache{"+partitionId+"}", unit.OwnerId+":"+unit.Id, unit.Position)]
    
    unit.Health = health
    
    await Promise.all(commands)*/
    database.updateUnits([unit], includeHealth)
}

database.damageUnit = async (unit, damage) => {
    let health = await redis.hincrby("unit{"+ unit.OwnerId+"}"+unit.Id, "Health", -damage)

    if (health <= 0)
        redis.hdel("militaryUnitCache{"+unit.PartitionId+"}", unit.OwnerId+":"+unit.Id)

    return health
}

//DO NOT USE YET
database.damageUnitByKey = async (key, damage, unitPosition) => {
    let [ownerId, unitId] = key.split(":")
    let health = await redis.hincrby("unit{"+ ownerId+"}"+unitId, "Health", -damage)
    let partition = common.findPartitionId(unitPosition)

    if (health <= 0)
        redis.hdel("militaryUnitCache{"+unit.PartitionId+"}", ownerId+":"+unitId)

    return health
}

database.getUnitIdsAtPosition = async (pos) => {
    return database.getUnitIdsAtPositions([pos])
}

database.getUnitIdsAtPositions = async (posList) => {
    console.log("Unimplemented getUnitIdsAtPositions")
}

database.getUnitIdsAtPartitions = async (partitions) => {
    console.log("Unimplemented getUnitIdsAtPartitions")
}

// militaryUnitCache{partitionId} = {userid:unitid = position, ...}
// returns dict[position] = [userid:unitid, ...]
database.getMilitaryUnitPositionsInPartition = async (partitionId) => {
    let data = await redis.hgetall("militaryUnitCache{"+partitionId+"}")
    let positionDict = {}

    if (data) {
        for (let key in data) {
            let position = data[key]

            if (!positionDict[position])
                positionDict[position] = []

            positionDict[position].push(key)
        }
    }

    return positionDict
}   

// unitCache{partitionId} = {userid:unitid = position, ...}
// returns [unit1, unit2, ...]
database.getUnitsAtPartitions = async (partitions) => {
    let idMap = {}
    let fetching = []

    for (let partitionId in partitions)
        fetching.push(redis.hgetall("unitCache{"+partitionId+"}", 
                (e, dict) => Object.assign(idMap, dict)))

    await Promise.all(fetching)

    let unitList = []
    let pipelines = {requestedPipeline: redis.pipeline()}
    fetching = []

    for (let id in idMap) {
        let [ownerId, unitId] = id.split(":")

        if (!pipelines[ownerId])
            pipelines[ownerId] = redis.pipeline()
        
        database.resetFullSimQuota(ownerId)
        pipelines[ownerId].hgetall("unit{"+ownerId+"}"+unitId, 
            (e, unit) => unit.Id && unitList.push(unit))
    }

    for (let i in pipelines)
        fetching.push(pipelines[i].exec())

    await Promise.all(fetching)
    return unitList
}

database.getStat = (id, type) => {
    return redis.hget("stats:"+id, type)
}

database.addStat = (id, type, amount) => {
    redis.hincrbyfloat("stats:"+id, type, parseFloat(amount || 0))
}

database.setStat = (id, type, value) => {
    redis.hset("stats:"+id, type, value)
}

database.setStats = (id, stats) => {
    redis.hmset("stats:"+id, userstats.storePrep(stats))
}

database.getStats = async (id) => {
    return userstats.sanitise(await redis.hgetall("stats:"+id))
}

database.resetFullSimQuota = async (id) => {
    if (!fullSimCache.has(id)) {
        fullSimCache.add(id)
        database.setStat(id, "RequiredFullSims", common.FULL_SIM_QUOTA)
        database.setKingdomLoaded(id)
    }
}

database.getRemainingFullSimQuota = async (id) => {
    return await redis.hincrby("stats:"+id, "RequiredFullSims", -1)
}

database.setKingdomLoaded = (userId) => {
    redis.sadd("loadedKingdoms", userId)
}

database.setKingdomUnloaded = (userId) => {
    redis.srem("loadedKingdoms", userId)
}

database.getLoadedKingdoms = async () => {
    return await redis.smembers("loadedKingdoms")
}

database.clearCaches = () => {
    fullSimCache.clear()
}

database.getAllSettings = async () => {
    let Settings = {}
    let settings = await redis.hgetall('settings')
    let num = 0

    for (let key in settings) {
        Settings[key] = JSON.parse(settings[key])
        num++
    }

    console.log("Loaded", num, "user settings!")

    return Settings
}

database.getUnitCount = async () => {
    return await redis.get("unitcount")
}

database.getUnitSpawns = async (id) => {
    return redis.hgetall("unitspawns:"+id)
}

database.getUnitCollection = async (id) => {
    return redis.lrange("unitcollection:"+id, 0, -1)
}

database.getActionQueue = async (id) => {
    let actions = await redis.lrange("actionQueue:"+id, 0, -1)
    redis.ltrim("actionQueue:"+id, actions.length, -1)

    return actions
}

database.addPlayer = (id) => {
    redis.rpush("playerlist", id)
}

database.getPlayerList = async () => {
    return redis.lrange("playerlist", 0, -1)
}

database.updateSettings = (id, settings) => {
    redis.hset("settings", id, JSON.stringify(settings))
}

database.updateUnitSpawn = async (id, pos, count) => {
    await redis.hset("unitspawns:"+id, pos, count)
}

database.deleteUnitSpawn = async (id, pos) => {
    await redis.hdel("unitspawns:"+id, pos)
}

database.updateUnitCount = (count) => {
    redis.set("unitcount", count)
}

database.incrementUnitCount = () => {
    return redis.incr("unitcount")
}

database.pushUnitToCollection = (ownerId, unitId) => {
    redis.rpush("unitcollection:"+ownerId, unitId)
}

database.removeUnitFromCollection = (ownerId, unitId) => {
    redis.lrem("unitcollection:"+ownerId, 0, unitId)
}

database.setDeadUnitExpiration = (unit) => {
    redis.hdel("unitCache{"+unit.PartitionId+"}", unit.OwnerId+":"+unit.Id)
    redis.expire("unit{"+unit.OwnerId+"}"+unit.Id, 10)
}

database.removeUnitFromHome = async (unit) => {
    let tile = await database.getTile(unit.Home)
    tiles.sanitise(tile)
    tile.UnitList = tile.UnitList.filter(id => {
        console.log(id, unit.Id, id != unit.Id)
        id != unit.Id})
    await database.updateTile(unit.Home, tile)
}

database.updateTile = async (position, tile) => {
    let pipeline = redis.pipeline()

    //Update tile definition
    let partitionId = common.findPartitionId(position)
    pipeline.hmset("tile{"+partitionId+"}"+tile.Position, tiles.storePrep(tile))
    
    //Calculate location of tile in partition hash
    let cacheIndex = common.partitionIndex(position)

    //0 = grass, 1 = walkable, 2 = non-walkable, 3 = storage,
    let walkableVal = !(tiles.getSafeType(tile) == tiles.TileType.GRASS) + !tiles.isWalkable(tile, true) + tiles.isStorageTile(tile)
    //How many adjacent tiles of the same type are there
    let neighbours = await tiles.getNeighbours(position)
    let adjacentVal = await tiles.getNumberOfSimilarAdjacentTiles(tile, neighbours)

    //Update fast lookup partition caches
    pipeline.setnx("versionCache{"+partitionId+"}", "0".repeat(partitionSize**2))
    pipeline.setnx("fastPathCache{"+partitionId+"}", "0".repeat(partitionSize**2))
    pipeline.setnx("adjacencyCache{"+partitionId+"}", "0".repeat(partitionSize**2))
    pipeline.bitfield("versionCache{"+partitionId+"}", "SET", "u8", cacheIndex * 8, 48 + tile.CyclicVersion)
    pipeline.bitfield("fastPathCache{"+partitionId+"}", "SET", "u8", cacheIndex * 8, 48 + walkableVal)
    pipeline.bitfield("adjacencyCache{"+partitionId+"}", "SET", "u8", cacheIndex * 8, 48 + adjacentVal, 
        (e, previousValue) => {if (previousValue[0] != 48 + adjacentVal) database.updateAdjacencyCaches(neighbours)})

    await pipeline.exec()
}

//Update surrounding tiles adjacency values
database.updateAdjacencyCaches = async (tileList) => {
    for (let tile of tileList) {
        if (!tile) continue

        let partitionId = common.findPartitionId(tile.Position)
        let cacheIndex = common.partitionIndex(tile.Position)
        let adjacentVal = await tiles.getNumberOfSimilarAdjacentTiles(tile)
        
        redis.setnx("adjacencyCache{"+partitionId+"}", "0".repeat(partitionSize**2))
        redis.bitfield("adjacencyCache{"+partitionId+"}", "SET", "u8", cacheIndex * 8, 48 + adjacentVal)
    }
}

database.getFastPathCache = async (partitionId) => {
    let cache = await redis.get("fastPathCache{"+partitionId+"}")
    
    if (!cache) {
        cache = "0".repeat(partitionSize**2)
        redis.set("fastPathCache{"+partitionId+"}", cache)
    }

    return cache
}

database.getAdjacencyCache = async (partitionId) => {
    let cache = await redis.get("adjacencyCache{"+partitionId+"}")
    
    if (!cache) {
        cache = "0".repeat(partitionSize**2)
        redis.set("adjacencyCache{"+partitionId+"}", cache)
    }

    return cache
}

//Do not use to update type as this skips type dependant caches
//Use the full updateTile method for type/significant updates
database.incrementTileProp = async (position, prop, value) => {
    let pipeline = redis.pipeline()

    let partitionId   = common.findPartitionId(position)
    let cacheIndex    = common.partitionIndex(position)
    let cyclicVersion = await redis.hget("tile{"+partitionId+"}"+position, "CyclicVersion")
    let health

    pipeline.hincrby("tile{"+partitionId+"}"+position, prop, value, (e, val) => health = val)
    pipeline.hset("tile{"+partitionId+"}"+position, "CyclicVersion", 49 + cyclicVersion%9)
    pipeline.setnx("versionCache{"+partitionId+"}", "0".repeat(partitionSize**2))
    pipeline.bitfield("versionCache{"+partitionId+"}", "SET", "u8", cacheIndex * 8, 49 + cyclicVersion%9)

    await pipeline.exec()
    console.log("Health from increment tile prop", health)
    return health
}

database.deleteTile = async (position) => {
    let pipeline = redis.pipeline()

    //Delete tile definition
    let partitionId = common.findPartitionId(position)
    pipeline.del("tile{"+partitionId+"}"+position)
    
    //Calculate location of tile in partition hash
    let cacheIndex = common.partitionIndex(position)
    let neighbours = await tiles.getNeighbours(position) 

    //Update fast lookup partition caches
    pipeline.setnx("versionCache{"+partitionId+"}", "0".repeat(partitionSize**2))
    pipeline.setnx("fastPathCache{"+partitionId+"}", "0".repeat(partitionSize**2))
    pipeline.setnx("adjacencyCache{"+partitionId+"}", "0".repeat(partitionSize**2))
    pipeline.bitfield("versionCache{"+partitionId+"}", "SET", "u8", cacheIndex * 8, 48)
    pipeline.bitfield("fastPathCache{"+partitionId+"}", "SET", "u8", cacheIndex * 8, 48)
    pipeline.bitfield("adjacencyCache{"+partitionId+"}", "SET", "u8", cacheIndex * 8, 48, 
        (e, previousValue) => {if (previousValue[0] != 48) database.updateAdjacencyCaches(neighbours)})

    await pipeline.exec()
}

database.updateStatus = (time, status) => {
    redis.set("lastprocess", time)
    redis.set("status", status)
}

database.waitForRedis = async () => {
    return await redis.wait(1, 2000)
}

database.setRoundStart = () => {
    redis.set("roundStart", new Date().getTime())
}

database.incrementRoundCount = () => {
    redis.incr("roundCount")
}

database.getRoundCount = async () => {
    return await redis.get("roundCount")
}  

database.setLastSimRoundNumber = (userId, roundNumber) => {
    database.setStat(userId, "lastSimRound", roundNumber)
}

database.getLastSimRoundNumber = async (userId) => {
    return database.getStat(userId, "lastSimRound")
}

database.setPartitionOwner = async (userId, partitionId) => {
    let assigned = await redis.setnx("{PartitionOwner}:"+partitionId, userId)

    if (!assigned)
        redis.sadd("PartitionOwnership{"+userId+"}", partitionId)
}

database.deletePartitionOwner = async (partitionId) => {
    let owner = await redis.get("PartitionOwner:"+partitionId)

    if (owner) {
        redis.del("{PartitionOwner}:"+partitionId)
        redis.srem("PartitionOwnership{"+owner+"}", partitionId)
    }
}

database.getPartitionOwner = async (partitionId) => {
    return await redis.get("{PartitionOwner}:"+partitionId)
}

database.getPartitionsOwned = async (userId) => {
    return await redis.smembers("PartitionOwnership{"+userId+"}")
}

database.getOwnersOfPartitions = async (partitionList) => {
    let ownerMap = {}
    let pipeline = redis.pipeline()

    for (let partitionId of partitionList) {
        pipeline.get("{PartitionOwner}:"+partitionId, (e, owner) => {
            if (owner) 
                ownerMap[partitionId] = owner
        })
    }

    await pipeline.exec()
    return ownerMap
}

database.deletePartition = async (partitionId) => {
    let pipeline = redis.pipeline()

    pipeline.del("versionCache{"+partitionId+"}")
    pipeline.del("fastPathCache{"+partitionId+"}")
    pipeline.del("adjacencyCache{"+partitionId+"}")

    let [x, y] = common.findXYFromPartitionId(partitionId)

    for (let dx = 0; dx < partitionSize; dx++)
        for (let dy = 0; dy < partitionSize; dy++)
            pipeline.del("tile{"+partitionId+"}"+(x+dx)+':'+(y+dy))

    pipeline.exec()

    redis.del("{PartitionOwner}:"+partitionId)
}

database.deleteUnitsAtPartition = async (partitionId) => {
    let pipeline = redis.pipeline()

    pipeline.del("militaryUnitCache{"+partitionId+"}")
    pipeline.del("unitCache{"+partitionId+"}")

    pipeline.exec()
}

database.deleteKingdom = async (id) => {
    //delete partitions
    let partitions = await database.getPartitionsOwned(id)
    for (let partitionId of partitions) {
        database.deletePartition(partitionId)
        database.deleteUnitsAtPartition(partitionId)
    }

    //delete units
    let units = await database.getUnitCollection(id)
    for (let unitId of units)
        redis.del("unit{"+id+"}"+unitId)

    redis.del("unitcollection:"+id)
    redis.del("unitspawns:"+id)

    //delete stats
    redis.del("stats:"+id)

    //delete settings
    redis.hdel("settings", id)
    redis.del("PartitionOwnership{"+id+"}")
}

database.assignGuardpost = async (id, position) => {
    redis.sadd("guardposts{"+id+"}", position)
}

database.unassignGuardpost = async (id, position) => {
    redis.srem("guardposts{"+id+"}", position)
}

database.getGuardposts = async (id) => {
    return redis.smembers("guardposts{"+id+"}")
}

database.getGuardpostsFromList = async (idList) => {
    let guardposts = {}

    for (let id of idList)
        guardposts[id] = await database.getGuardposts(id)

    return guardposts
}