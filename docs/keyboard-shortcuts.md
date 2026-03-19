# Herd Keyboard Shortcuts

Herd is primarily keyboard-driven. This page tracks the current shortcut surface implemented in the app.

## Modes

- `i`: enter input mode for the selected shell
- `Shift+Esc`: leave input mode and return to command mode
- `:`: open the command bar
- `?`: open help; any key or click closes it
- `b`: toggle the tmux tree sidebar
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

## Shells And Tabs

- `s`: spawn a new shell
- `x`: close the selected shell
- `t`: create a new tab
- `w` or `X`: close the active tab

## Sidebar

- `j / k`: move the tree selection
- `r`: prefill a rename command for the selected item
- `i`: enter input mode for the selected shell
- `z`: zoom to the selected shell
- `Z`: fullscreen zoom the selected shell
- `Esc` or `b`: close the sidebar

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

## Close Confirmation

- `Enter`, `y`, `Y`, or `X`: confirm closing the tab
- `Esc`, `n`, or `N`: cancel
