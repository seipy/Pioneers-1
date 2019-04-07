local Replication = {}

local Client = script.Parent
local ViewUnit = require(Client.ViewUnit)
local ViewStats = require(Client.ViewStats)
local ViewTile = require(Client.ViewTile)
local Network = game.ReplicatedStorage.Network

local currentWorld
local currentStats

function Replication.getWorldState()
    print("Getting world state")
    currentWorld = Network.RequestWorldState:InvokeServer()
    return currentWorld
end

function Replication.getUserStats()
    currentStats = Network.RequestStats:InvokeServer()
    return currentStats
end

function Replication.requestTilePlacement(tile, type)

    local success = Network.RequestTilePlacement:InvokeServer(tile, type)

    if not success then
        print("Tile placement request failed!")
    end
end

function Replication.requestUnitHome(unit, tile)
    local success = Network.RequestUnitHome:InvokeServer(unit, tile)

    if not success then
        print("Home request failed!")
    end
end

function Replication.requestUnitWork(unit, tile)
    local success = Network.RequestUnitWork:InvokeServer(unit, tile)

    if not success then
        print("Work request failed!")
    end
end

function Replication.requestUnitTarget(unit, tile)
    local success = Network.RequestUnitTarget:InvokeServer(unit, tile)

    if not success then
        print("Target request failed!")
    end
end

local function handleUnitUpdate(unit)
    repeat wait() until currentWorld
    local localUnit = currentWorld.Units[unit.ID]

    if not localUnit then
        currentWorld.Units[unit.ID] = unit
        ViewUnit.displayUnit(unit)
    else

        for i, v in pairs(unit) do
            localUnit[i] = v
        end

        ViewUnit.updateDisplay(localUnit)
    end
end

local function handleStatsUpdate(stats)
    for i, v in pairs(stats) do
        currentStats[i] = v
    end

    currentStats.changed()
end

local function handleTileUpdate(tile)

    local pos = tile.Position
    local localTile = currentWorld.Tiles[pos.x][pos.y] 

    for i, v in pairs(tile) do
        localTile[i] = v 
    end

    ViewTile.updateDisplay(localTile)
end

Network.UnitUpdate.OnClientEvent:Connect(handleUnitUpdate)
Network.StatsUpdate.OnClientEvent:Connect(handleStatsUpdate)
Network.TileUpdate.OnClientEvent:Connect(handleTileUpdate)

return Replication