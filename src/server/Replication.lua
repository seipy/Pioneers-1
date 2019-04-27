local Replication = {}
local Common      = game.ReplicatedStorage.Pioneers.Common

local Tile      = require(Common.Tile)
local Unit      = require(Common.Unit)
local UserStats = require(Common.UserStats)
local Util      = require(Common.Util)
local World     = require(Common.World)

local Network = game.ReplicatedStorage.Network
local Players = game:GetService("Players")
local Http    = game:GetService("HttpService")

local API_URL = "https://api.mysty.dev/pion/"
local Actions = {NEW_PLAYER = 0, PLACE_TILE = 1, SET_WORK = 2, ATTACK = 3}

local currentWorld

local function worldStateRequest(player)
    return currentWorld
end

local function statsRequest(player)
    return UserStats.Store[player.UserId]
end

local function tilePlacementRequest(player, tile, type)
    
    local stile = World.getTile(currentWorld.Tiles, tile.Position.x, tile.Position.y)

    for i, v in pairs(tile) do --TODO: bad!
        stile[i] = v
    end

    stile.OwnerId = player.UserId

    local payload = {
        id = player.UserId,
        action = Actions.PLACE_TILE,
        type = type,
        position = Tile.getIndex(tile)
    }

    local res = Http:PostAsync(API_URL.."actionRequest", Http:JSONEncode(payload))
    res = Http:JSONDecode(res)

    return res.status == "Ok"
end

local function unitWorkRequest(player, unit, tile)
    
    local payload = {
        id = player.UserId,
        action = Actions.SET_WORK,
        unitId = unit.Id,
        position = Tile.getIndex(tile)
    }

    print("WorkRequest:", Actions.SET_WORK, Tile.getIndex(tile))

    local res = Http:PostAsync(API_URL.."actionRequest", Http:JSONEncode(payload))
    res = Http:JSONDecode(res)

    return res.status == "Ok"
end

local function unitAttackRequest(player, unit, tile)

    local payload = {
        id = player.UserId,
        action = Actions.ATTACK,
        unitId = unit.Id,
        position = Tile.getIndex(tile)
    }

    local res = Http:PostAsync(API_URL.."actionRequest", Http:JSONEncode(payload))
    res = Http:JSONDecode(res)

    print("Attack:", res.status)

    return res.status == "Ok"
end

local function getCircularTiles(player, pos, radius)
    return Util.circularCollection(currentWorld.Tiles, pos.x, pos.y, 0, radius)
end

function Replication.assignWorld(w)
    currentWorld = w

    Network.RequestWorldState.OnServerInvoke    = worldStateRequest
    Network.RequestStats.OnServerInvoke         = statsRequest
    Network.RequestTilePlacement.OnServerInvoke = tilePlacementRequest
    Network.RequestUnitWork.OnServerInvoke      = unitWorkRequest
    Network.RequestUnitAttack.OnServerInvoke    = unitAttackRequest
    Network.GetCircularTiles.OnServerInvoke     = getCircularTiles
    Network.Ready.OnServerInvoke = function() return true end
end

function Replication.pushUnitChange(unit)
    local payload = Unit.serialise(unit)
    Http:PostAsync("https://api.mysty.dev/pion/unitupdate", payload)

    Network.UnitUpdate:FireAllClients(unit)
end

function Replication.pushStatsChange(stats)
    local player = Players:GetPlayerByUserId(stats.PlayerId)
    
    if player then
        Network.StatsUpdate:FireClient(player, stats)
    end
end

function Replication.pushTileChange(tile)
    Network.TileUpdate:FireAllClients(tile)
end

function Replication.tempSyncUnit(unit)
    Network.UnitUpdate:FireAllClients(unit)
end

Network.Ready.OnServerInvoke = function() return false end

return Replication