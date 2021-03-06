local Util   = {}
local Common = game.ReplicatedStorage.Pioneers.Common

local World = require(Common.World)
local Tile  = require(Common.Tile)
local Unit  = require(Common.Unit)

local TILESPACING = 10 --Distance from center of hexagon to edge vertex
local EDGESPACING = TILESPACING * (0.5 * 3^.5)

local YOFFSET = EDGESPACING * 2 * Vector3.new(1, 0, 0)
local XOFFSET = EDGESPACING * 2 * Vector3.new(-0.5, 0, 0.866)

local PARTITIONSIZE = 20
Util.PARTITIONSIZE = PARTITIONSIZE

local getTileXY = World.getTileXY
local format = string.format

function Util.axialCoordToWorldCoord(position)
    return position.y * YOFFSET + position.x * XOFFSET
end

function Util.worldCoordToAxialCoord(position)

    local x = math.floor(position.z / XOFFSET.z + 0.5)
    local y = math.floor((position.x - XOFFSET.x * x) / YOFFSET.x + 0.5)

    return Vector2.new(x, y)
end

function Util.positionStringToVector(posStr)
    local x, y = unpack(string.split(posStr, ':'))
    return Vector2.new(tonumber(x), tonumber(y))
end

function Util.vectorToPositionString(pos)
    return pos.x..":"..pos.y
end

function Util.worldVectorToAxialPositionString(pos)
    return Util.vectorToPositionString(Util.worldCoordToAxialCoord(pos))
end

function Util.circularCollection(tiles, posx, posy, startRadius, endRadius)

    local collection = {}

    if startRadius == 0 then
        table.insert(collection, getTileXY(tiles, posx, posy))
    end

    for radius = startRadius, endRadius do
        for i = 0, radius-1 do
            table.insert(collection, getTileXY(tiles, posx +          i, posy +     radius))
            table.insert(collection, getTileXY(tiles, posx +     radius, posy + radius - i))
            table.insert(collection, getTileXY(tiles, posx + radius - i, posy -          i))
            table.insert(collection, getTileXY(tiles, posx -          i, posy -     radius))
            table.insert(collection, getTileXY(tiles, posx -     radius, posy - radius + i))
            table.insert(collection, getTileXY(tiles, posx - radius + i, posy +          i))
        end
    end

    return collection
end

function Util.circularPosCollection(posx, posy, startRadius, endRadius)
    debug.profilebegin("circularPosCollection")
    local collection = {}
    
    if startRadius == 0 then
        table.insert(collection, posx .. ":" .. posy)
    end

    for radius = startRadius, endRadius do
        for i = 0, radius-1 do
            table.insert(collection, string.format("%d:%d", (posx +          i), (posy +     radius)))
            table.insert(collection, string.format("%d:%d", (posx +     radius), (posy + radius - i)))
            table.insert(collection, string.format("%d:%d", (posx + radius - i), (posy -          i)))
            table.insert(collection, string.format("%d:%d", (posx -          i), (posy -     radius)))
            table.insert(collection, string.format("%d:%d", (posx -     radius), (posy - radius + i)))
            table.insert(collection, string.format("%d:%d", (posx - radius + i), (posy +          i)))
        end
    end
    debug.profileend()

    return collection
end

--In Util as requires both Tile and Unit
function Util.worksOnTileType(unit, tileType)
    if not unit then return end

    local unitType = unit.Type

    if tileType == Tile.FARM and unitType == Unit.FARMER then
        return true
    elseif tileType == Tile.FORESTRY and unitType == Unit.LUMBERJACK then
        return true
    elseif tileType == Tile.MINE and unitType == Unit.MINER then
        return true
    elseif tileType == Tile.BARRACKS and Unit.isMilitary(unit) and unit.State == Unit.UnitState.TRAINING then
        return true
    end
end

function Util.findPartitionId(x, y)
    local x = math.floor(x / PARTITIONSIZE)
    local y = math.floor(y / PARTITIONSIZE)
    x = x >= 0 and x * 2 or -x * 2 - 1
    y = y >= 0 and y * 2 or -y * 2 - 1
    return tostring(0.5 * (x + y) * (x + y + 1) + y)
end

function Util.partitionIdToCoordinates(id)
    id = tonumber(id)

    local w = math.floor(((8 * id + 1)^.5 - 1) / 2)
    local t = (w^2 + w) / 2
    local y = id - t
    local x = w - y

    x = x%2>0 and (x + 1) / -2 or x / 2
    y = y%2>0 and (y + 1) / -2 or y / 2

    return x * PARTITIONSIZE, y * PARTITIONSIZE
end

function Util.findOverlappedPartitions(position)
    local vec = Util.positionStringToVector(position)
    local viewDistance = 30
    
    local xmax = vec.x + viewDistance
    local xmin = vec.x - viewDistance
    local ymax = vec.y + viewDistance
    local ymin = vec.y - viewDistance

    local overlappedPartitions = {}

    for x = xmin, xmax, PARTITIONSIZE do
        for y = ymin, ymax, PARTITIONSIZE do
            table.insert(overlappedPartitions, Util.findPartitionId(x, y))
        end
    end

    return overlappedPartitions
end

function Util.tableCopy(copyTable)
    local newTable = {}

    for i, v in pairs(copyTable) do
        newTable[i] = v
    end

    return newTable
end

return Util