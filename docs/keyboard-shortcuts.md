# Herd Keyboard Shortcuts

Herd is primarily keyboard-driven. This page tracks the current shortcut surface implemented in the app.

## Modes

- `i`: enter input mode for the selected shell
- `Shift+Esc`: leave input mode and return to command mode
- `:`: open the command bar
- `?`: open help; any key or click closes it
- `b`: toggle the `TREE` sidebar
- `d`: toggle the debug pane

## Navigation

- `h / j / k / l`: focus left / down / up / right
- `n / p`: select next / previous shell
- `N / P`: select next / previous tab

## Move + Pan

- `Ctrl+h/j/k/l`: move the selected shell
- `Ctrl+Shift+h/j/k/l`: move the selected shell faster
- `H / J / K / L`: pan the canvas

## View

- `z`: toggle zoom to the selected shell
- `Z`: toggle fullscreen zoom
- `Shift+-`: zoom the canvas out
- `Shift+=`: zoom the canvas in
- `f`: fit all shells in view
- `0`: reset canvas zoom and pan
- `a`: cycle anchored arrangements for the active tab (`circle`, `snowflake`, `stack-down`, `stack-right`, `spiral`) and fit the view

## Tiles And Tabs

- `s`: spawn a new shell
- `x`: close the selected shell
- `t`: create a new tab
- `w` or `X`: close the active tab

## Sidebar

- `Shift+j / Shift+k`: focus the next / previous sidebar section
- `j / k`: move within the focused sidebar section
- `r`: prefill a rename command for the selected item
- `i`: enter input mode for the selected shell
- `z`: zoom to the selected shell
- `Z`: fullscreen zoom the selected shell
- `Esc` or `b`: close the sidebar

Sidebar section order is:

- `SETTINGS`
- `WORK`
- `AGENTS`
- `TMUX`

The `SETTINGS` section currently includes:

- `SPAWN DIR`
- `PORTS`
  - toggle between `4`, `8`, `12`, and `16` total visible ports per tile

## Command Bar

Examples:

- `:sh`, `:shell`, `:new`: spawn a new shell
- `:q`, `:close`: close the selected shell
- `:qa`, `:closeall`: close all shells in the active tab
- `:rename <name>`: rename the selected shell
- `:tn [name]`, `:tabnew [name]`: create a new tab
- `:tc`, `:tabclose`: close the active tab
- `:tr <name>`, `:tabrename <name>`: rename the active tab
- `:z`, `:zoom`: zoom to the selected shell
- `:fit`: fit all shells in view
- `:reset`: reset the canvas
- `:sudo <message>`: send a Root message as `User`
- `:dm <agent_id|AgentNumber|root> <message>`: send a direct message as `User`
- `:cm <message>`: send a public chatter message as `User`

Notes:

- dialog/input modals automatically take input focus and suppress global shortcuts while they are open
- command-bar `:dm 10 hi` resolves `10` against the current session's `Agent 10`
- `:cm` maps to public chatter for the current session only

## Close Confirmation

- `Enter`, `y`, `Y`, or `X`: confirm closing the tab
- `Esc`, `n`, or `N`: cancel
