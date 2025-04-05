# Auto Numbering 

0.1.3.3.對每行資料加上數值編號，根據他們左右的相對位置。 

## Demo

## VS Code API

### `vscode` module

- [`commands.registerCommand`](https://code.visualstudio.com/api/references/vscode-api#commands.registerCommand)
- [`window.showInformationMessage`](https://code.visualstudio.com/api/references/vscode-api#window.showInformationMessage)

### Contribution Points

- [`contributes.commands`](https://code.visualstudio.com/api/references/contribution-points#contributes.commands)

## Commands

### Move Lines Left

Moves the current line and its same-level lines (and their child levels) to the left.

- Default Keybinding: `Ctrl+Alt+Left` (Windows/Linux), `Cmd+Alt+Left` (Mac)

### Move Lines Right

Moves the current line and its same-level lines (and their child levels) to the right.

- Default Keybinding: `Ctrl+Alt+Right` (Windows/Linux), `Cmd+Alt+Right` (Mac)

### Adjust Lines by Level

Adjusts each line's indentation based on its level.

- Level 0: X = 0
- Level 1: X = 2
- Level 2: X = 4
- Level 3: X = 6
- And so on...

- Default Keybinding: `Ctrl+Alt+L` (Windows/Linux), `Cmd+Alt+L` (Mac)

