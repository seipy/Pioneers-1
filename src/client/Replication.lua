local Replication = {}
local Client      = script.Parent
local Common      = game.ReplicatedStorage.Pioneers.Common

local ViewUnit   = require(Client.ViewUnit)
local ViewTile   = require(Client.ViewTile)
local ClientUtil = require(Client.ClientUtil)
local World      = require(Common.World)
local Tile       = require(Common.Tile)
local Util       = require(Common.Util)
local UserStats  = require(Common.UserStats)
local Network    = game.ReplicatedStorage.Network

local currentWorld
local currentStats = {}
local syncing = true

local function tileSync()
    while syncing do
        local pos = Util.worldCoordToAxialCoord(ClientUtil.getPlayerPosition())
        local dist = ClientUtil.getCurrentViewDistance()
        Replication.updateTiles(pos, dist)
        wait(1)
    end
end

function Replication.init(world)
    currentWorld = world

    unitupdate = Network.UnitUpdate.OnClientEvent:Connect(handleUnitUpdate)
    statsupdate = Network.StatsUpdate.OnClientEvent:Connect(handleStatsUpdate)
    tileupdate = Network.TileUpdate.OnClientEvent:Connect(handleTileUpdate)

    _G.updateLoadStatus("Fetching map data...")
    spawn(tileSync)
end

function Replication.worldDied()
    if unitupdate then
        unitupdate:Disconnect()
        statsupdate:Disconnect()
        tileupdate:Disconnect()
    end
end

function Replication.getUserStats()

    _G.updateLoadStatus("Fetching user stats...")

    repeat
        currentStats = Network.RequestStats:InvokeServer()
    until currentStats

    currentStats.Offset = {}
    return currentStats
end

function Replication.requestTilePlacement(tile, type)

    local success
    local reqs = Tile.ConstructionCosts[type]

    if UserStats.hasEnoughResources(currentStats, reqs) then
        for res, amount in pairs(reqs) do
            currentStats[res] = currentStats[res] - amount
            currentStats.Offset[res] = amount
        end

        success = Network.RequestTilePlacement:InvokeServer(tile, type)
    end

    if not success then
        print("Tile placement request failed!")
    end
end

function Replication.requestUnitWork(unit, tile)
    local success = Network.RequestUnitWork:InvokeServer(unit, tile)

    if not success then
        print("Work request failed!")
    end
end

function Replication.requestUnitAttack(unit, tile)
    local success = Network.RequestUnitAttack:InvokeServer(unit, tile)

    if not success then
        print("Attack request failed!")
    end
end

function handleUnitUpdate(unit)
    repeat wait() until currentWorld
    local localUnit = currentWorld.Units[unit.Id]

    if not localUnit then
        currentWorld.Units[unit.Id] = unit
        ViewUnit.displayUnit(unit)
    else

        for i, v in pairs(unit) do
            localUnit[i] = v
        end

        ViewUnit.updateDisplay(localUnit)
    end
end

function handleStatsUpdate(stats)
    for i, v in pairs(stats) do
        if currentStats.Offset and currentStats.Offset[i] then
            currentStats[i] = v - currentStats.Offset[i]
            currentStats.Offset[i] = nil
        else
            currentStats[i] = v
        end
    end
end

function handleTileUpdate(tile)

    local pos = tile.Position
    local localTile = World.getTile(currentWorld.Tiles, pos.x, pos.y)

    for i, v in pairs(tile) do
        localTile[i] = v
    end

    ViewTile.updateDisplay(localTile)
end

function Replication.updateTiles(pos, radius)
    local tiles = Network.GetCircularTiles:InvokeServer(pos, radius)

    for _, tile in pairs(tiles) do
        handleTileUpdate(tile)
    end
end

function Replication.ready()
    _G.updateLoadStatus("Waiting for server to be ready...")
    return Network.Ready:InvokeServer()
end

return Replication