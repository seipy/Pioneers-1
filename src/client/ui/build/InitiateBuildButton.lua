local ui = script.Parent.Parent
local Roact = require(game.ReplicatedStorage.Roact)

local ToolTip = require(ui.common.ToolTip)

local InitiateBuildButton = Roact.Component:extend("InitiateBuildButton")

function InitiateBuildButton:init()
    
end

function InitiateBuildButton:render()
    return Roact.createElement("ImageButton", {
        Name                   = "InitiateBuildButton",
        BackgroundTransparency = 1,
        Position               = UDim2.new(0, 670, 1, -12),
        Size                   = UDim2.new(0,60,0,60),
        AnchorPoint            = Vector2.new(0, 1),
        Image                  = "rbxassetid://3464282669",
        [Roact.Event.MouseButton1Click] = self.props.UIBase.transitionToBuildView,
        [Roact.Event.MouseButton2Click] = self.props.UIBase.exitBuildView,
    }, {
        tooltip = Roact.createElement(ToolTip, {
            Position = UDim2.new(0.5, 0, 0.5, -30),
            Text = "Start building",
        })
    })
end

return InitiateBuildButton