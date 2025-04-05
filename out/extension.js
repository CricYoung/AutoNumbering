"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
let isActive = false; // 追蹤自動編號是否啟用
let changeTimeout; // 用於 debounce
const DEBOUNCE_DELAY = 300; // 延遲時間 (毫秒)，避免頻繁觸發
// --- Helper Functions ---
/**
 * 取得一行的縮排字串 (開頭的空白字元)
 * @param line TextLine 物件
 * @returns 該行的縮排字串
 */
function getIndentation(line) {
    const match = line.text.match(/^\s*/);
    return match ? match[0] : '';
}
/**
 * 根據中心行號和目標縮排，查找包含該行的邏輯區塊的起始和結束行號。
 * 邏輯區塊由空行或縮排減少的行分隔。
 * @param document 文檔對象
 * @param centerLineNum 變更發生的中心行號
 * @param targetIndentation 目標縮排
 * @returns 區塊的起始和結束行號，如果找不到則返回 undefined
 */
function findLogicalBlockRange(document, centerLineNum, targetIndentation) {
    let blockStart = centerLineNum;
    let blockEnd = centerLineNum;
    let foundTargetLine = false; // 標記是否在搜索範圍內找到過目標縮排的行
    // --- 向上搜索區塊起始行 ---
    for (let i = centerLineNum; i >= 0; i--) {
        const line = document.lineAt(i);
        if (!line.isEmptyOrWhitespace) {
            const indent = getIndentation(line);
            if (indent === targetIndentation) {
                blockStart = i; // 找到符合的行，可能是起始行，繼續向上
                foundTargetLine = true;
            }
            else if (indent.length < targetIndentation.length) {
                // 遇到縮排更少的行，區塊在此之上結束
                break;
            }
            // 縮排更多的行被忽略，繼續向上
        }
        else {
            // 遇到空行，區塊在此之上結束 (除非中心行就是空行)
            if (i < blockStart) { // 確保不是因為中心行是空行而立即停止
                break;
            }
        }
    }
    // --- 向下搜索區塊結束行 ---
    for (let i = centerLineNum; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        if (!line.isEmptyOrWhitespace) {
            const indent = getIndentation(line);
            if (indent === targetIndentation) {
                blockEnd = i; // 找到符合的行，可能是結束行，繼續向下
                foundTargetLine = true;
            }
            else if (indent.length < targetIndentation.length) {
                // 遇到縮排更少的行，區塊在此之下結束
                break;
            }
            // 縮排更多的行被忽略，繼續向下
        }
        else {
            // 遇到空行，區塊在此之下結束 (除非中心行就是空行)
            if (i > blockEnd) { // 確保不是因為中心行是空行而立即停止
                break;
            }
        }
    }
    // 如果在整個搜索過程中（向上和向下）都沒有找到任何符合 targetIndentation 的行，
    // 那麼就認為沒有找到有效的邏輯區塊。
    if (!foundTargetLine) {
        // 再做一次檢查，確保 centerLine 本身是否符合（處理單行區塊）
        const centerLineObj = document.lineAt(centerLineNum);
        if (!centerLineObj.isEmptyOrWhitespace && getIndentation(centerLineObj) === targetIndentation) {
            // 中心行本身就是一個有效的單行區塊
            return { start: centerLineNum, end: centerLineNum };
        }
        // 否則返回 undefined
        console.log(`Block search around line ${centerLineNum} found no lines matching indent "${targetIndentation}".`);
        return undefined;
    }
    console.log(`Logical block for indent "${targetIndentation}" around line ${centerLineNum} determined as: [${blockStart}, ${blockEnd}]`);
    return { start: blockStart, end: blockEnd };
}
/**
 * 移除行首的數字編號 (例如 "1. ", "12. ")
 * @param text 行文字
 * @returns 移除編號後的文字
 */
function removeLeadingNumber(text) {
    // 匹配開頭的空白 + 數字 + . + 空白
    return text.replace(/^\s*\d+\.\s+/, '');
}
// --- Core Logic ---
/**
 * 為具有特定縮排的行產生重新編號的編輯操作（處理區塊重設，跳過孤立行）。
 * 此函數現在返回編輯陣列，而不是直接應用它們。
 * @param editor 要操作的 TextEditor (用於 document)
 * @param targetIndentation 目標縮排字串
 * @returns vscode.TextEdit[] 編輯操作陣列
 */
function renumberLines(editor, targetIndentation) {
    console.log(`--- renumberLines generating edits for targetIndentation: "${targetIndentation}" ---`);
    const document = editor.document;
    const edits = [];
    let counter = 1; // 初始化計數器
    let inTargetBlock = false; // 跟蹤是否目前在目標縮排區塊內
    // 遍歷文件的每一行
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        const currentIndent = getIndentation(line);
        if (!line.isEmptyOrWhitespace) {
            // --- 非空行 ---
            if (currentIndent === targetIndentation) {
                // --- 找到符合目標縮排的行 ---
                // **新增：判斷是否為孤立行**
                const isPrevEmptyOrOOB = (i === 0) || document.lineAt(i - 1).isEmptyOrWhitespace;
                const isNextEmptyOrOOB = (i === document.lineCount - 1) || document.lineAt(i + 1).isEmptyOrWhitespace;
                const isIsolated = isPrevEmptyOrOOB && isNextEmptyOrOOB;
                if (!isIsolated) {
                    // --- 非孤立行：進行編號 ---
                    inTargetBlock = true; // 標記我們進入了目標區塊
                    const originalText = line.text;
                    const textWithoutIndent = targetIndentation === "" ? originalText : originalText.substring(targetIndentation.length);
                    const textWithoutNumber = removeLeadingNumber(textWithoutIndent.trimStart());
                    const newText = `${targetIndentation}${counter}. ${textWithoutNumber}`;
                    if (originalText !== newText) {
                        const existingRange = line.range;
                        if (document.validateRange(existingRange)) { // 使用 document 驗證範圍
                            edits.push(vscode.TextEdit.replace(existingRange, newText));
                            console.log(`  - Generating edit for line ${i}: "${originalText}" -> "${newText}" (Counter: ${counter})`);
                        }
                        else {
                            console.warn(`  - Invalid range for line ${i}, skipping edit.`);
                        }
                    }
                    else {
                        console.log(`  - Skipping line ${i}: Text already correct ("${originalText}") (Counter: ${counter})`);
                    }
                    // 只有非孤立行才增加計數器
                    counter++;
                }
                else {
                    // --- 孤立行：不編號，並移除可能已有的編號 ---
                    console.log(`  - Skipping isolated line ${i}: "${line.text}"`);
                    // 孤立行也算作區塊間隔，重設計數器
                    if (inTargetBlock) {
                        counter = 1;
                        inTargetBlock = false;
                    }
                    // 嘗試移除孤立行上可能存在的舊編號
                    const originalText = line.text;
                    const textWithoutNumber = removeLeadingNumber(originalText); // 直接移除編號
                    if (originalText !== textWithoutNumber) {
                        const existingRange = line.range;
                        if (document.validateRange(existingRange)) { // 使用 document 驗證範圍
                            edits.push(vscode.TextEdit.replace(existingRange, textWithoutNumber));
                            console.log(`  - Removing number from isolated line ${i}`);
                        }
                        else {
                            console.warn(`  - Invalid range for line ${i} (removing number), skipping edit.`);
                        }
                    }
                }
            }
            else if (currentIndent.length < targetIndentation.length) {
                // --- 找到縮排比目標小的行 ---
                // 重設計數器和區塊狀態
                if (inTargetBlock) {
                    console.log(`  - Line ${i} has less indentation ("${currentIndent}" < "${targetIndentation}"). Resetting counter.`);
                    counter = 1;
                    inTargetBlock = false;
                }
                counter = 1; // 確保重設
            }
            // 忽略縮排更多的行
        }
        else {
            // --- 空行或只有空白的行 ---
            // 重設計數器和區塊狀態
            if (inTargetBlock) {
                console.log(`  - Line ${i} is empty/whitespace, ending current block. Resetting counter.`);
                counter = 1;
                inTargetBlock = false;
            }
        }
    } // 文件行遍歷結束
    console.log(`Generated ${edits.length} edits.`);
    console.log(`--- renumberLines finished generating edits for targetIndentation: "${targetIndentation}" ---`);
    // **不再應用編輯，而是返回編輯列表**
    return edits;
}
/**
 * Moves lines to the left or right based on the clarified logic.
 * @param editor The active text editor.
 * @param direction The direction to move ("left" or "right").
 */
async function moveLines(editor, direction) {
    const document = editor.document;
    const position = editor.selection.active;
    const currentLine = document.lineAt(position.line);
    const currentIndentation = getIndentation(currentLine);
    // Step 1: If the current line has data starting from the top and the direction is "left", do nothing
    if (direction === "left" && currentLine.text.trimStart() === currentLine.text) {
        // vscode.window.showInformationMessage("Cannot move a line with data starting from the top to the left.");
        return;
    }
    // Step 2: Find the parent line or starting point
    let parentIndentation = "";
    let startLine = 0;
    for (let i = position.line - 1; i >= 0; i--) {
        const line = document.lineAt(i);
        if (line.isEmptyOrWhitespace) {
            startLine = i + 1;
            break;
        }
        const lineIndentation = getIndentation(line);
        if (lineIndentation.length < currentIndentation.length) {
            parentIndentation = lineIndentation;
            startLine = i + 1;
            break;
        }
    }
    // If no parent line or empty line is found, start from the top
    if (startLine === 0) {
        parentIndentation = "";
    }
    // Step 3: Move lines below the starting point
    const edits = [];
    let tLineTop = false;
    if (currentIndentation.length == 0)
        tLineTop = true; // 如果當前行的縮排為0，則表示它是頂部行
    for (let i = startLine; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        const lineIndentation = getIndentation(line);
        // Stop moving if we hit an empty line, end of text, or a line at the same or higher level as the parent
        if (i != startLine) {
            if (line.isEmptyOrWhitespace || (!tLineTop && (lineIndentation.length <= parentIndentation.length))) {
                break;
            }
        }
        let newIndentation;
        if (direction === "right") {
            // Add one level of indentation, even if the line starts with data at X > 0
            newIndentation = ' ' + lineIndentation;
        }
        else {
            // Remove one level of indentation, but ensure it doesn't go below X = 0
            newIndentation = lineIndentation.length > 0 ? lineIndentation.slice(1) : '';
        }
        const newText = newIndentation + line.text.trimStart();
        edits.push(vscode.TextEdit.replace(line.range, newText));
    }
    // Apply the edits
    if (edits.length > 0) {
        await editor.edit(editBuilder => {
            edits.forEach(edit => editBuilder.replace(edit.range, edit.newText));
        });
    }
}
/**
 * Adjusts each line's indentation based on its level relative to the leftmost line.
 * Level 0: X = 0, Level 1: X = 2, Level 2: X = 4, and so on.
 * @param editor The active text editor.
 */
async function adjustLinesByLevel(editor) {
    const document = editor.document;
    const edits = [];
    // Step 1: Find the leftmost line and its X position
    let curX = Infinity;
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        if (!line.isEmptyOrWhitespace) {
            const lineIndentation = getIndentation(line).length;
            curX = Math.min(curX, lineIndentation);
        }
    }
    if (curX === Infinity) {
        vscode.window.showInformationMessage("No lines to adjust.");
        return;
    }
    let curLevel = 0; // Initialize the current level
    // Step 2: Adjust lines based on their relative level
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        if (line.isEmptyOrWhitespace)
            continue;
        const lineIndentation = getIndentation(line).length;
        // Step 6: Adjust CurX and CurLevel based on the current line's X position
        if (lineIndentation > curX) {
            curX = lineIndentation;
            curLevel++;
        }
        else if (lineIndentation < curX) {
            curX = lineIndentation;
            curLevel = Math.max(0, curLevel - 1);
        }
        // Step 3: Adjust the current line's indentation
        const targetIndentation = ' '.repeat(curLevel * 2); // Adjust indentation to X = level * 2
        const newText = targetIndentation + line.text.trimStart();
        if (line.text !== newText) {
            edits.push(vscode.TextEdit.replace(line.range, newText));
        }
    }
    // Apply the edits
    if (edits.length > 0) {
        await editor.edit(editBuilder => {
            edits.forEach(edit => editBuilder.replace(edit.range, edit.newText));
        });
        vscode.window.showInformationMessage("Lines adjusted by relative level.");
    }
    else {
        vscode.window.showInformationMessage("No adjustments needed.");
    }
}
/**
 * 取得觸發變更的主要縮排層級
 * @param document
 * @param changes
 * @returns 縮排字串或 undefined
 */
function getAffectedIndentationLevel(document, changes) {
    if (changes.length === 0)
        return undefined;
    // 以第一個變更的位置為基準
    const firstChange = changes[0];
    const changeLine = firstChange.range.start.line;
    // 如果是刪除整行或在行首插入，參考前一行的縮排可能更準確
    let targetLineNum = changeLine;
    if (firstChange.text === '' && firstChange.range.isSingleLine && firstChange.range.start.character === 0) {
        // 刪除行首或整行
        targetLineNum = Math.max(0, changeLine - 1); // 嘗試看上一行
    }
    // 如果插入的是新行，也參考上一行
    if (firstChange.text.includes('\n') && firstChange.range.start.character === 0 && changeLine > 0) {
        targetLineNum = changeLine; // 插入多行時，以插入點的行為主
        // 但如果插入點在新行的開頭，需要特別判斷
        const lineBeforeChange = document.lineAt(Math.max(0, changeLine));
        // 嘗試從變更內容本身推斷縮排
        const lines = firstChange.text.split('\n');
        const firstNewLineIndent = getIndentation({ text: lines[0], isEmptyOrWhitespace: lines[0].trim() === '' });
        if (firstNewLineIndent !== '')
            return firstNewLineIndent;
        // 否則還是看插入位置的前一行或當前行（如果當前行非空）
        if (!lineBeforeChange.isEmptyOrWhitespace) {
            return getIndentation(lineBeforeChange);
        }
        else if (changeLine > 0) {
            return getIndentation(document.lineAt(changeLine - 1));
        }
    }
    if (targetLineNum >= document.lineCount) { // 如果變更發生在最後一行之後
        if (targetLineNum > 0)
            return getIndentation(document.lineAt(targetLineNum - 1)); // 看最後一行
        else
            return ""; // 文件是空的
    }
    const line = document.lineAt(targetLineNum);
    // 如果目標行是空的，嘗試找上一行非空的縮排
    if (line.isEmptyOrWhitespace && targetLineNum > 0) {
        for (let i = targetLineNum - 1; i >= 0; i--) {
            const prevLine = document.lineAt(i);
            if (!prevLine.isEmptyOrWhitespace) {
                return getIndentation(prevLine);
            }
        }
        return ""; // 往上都找不到，可能是文件開頭的空行
    }
    return getIndentation(line);
}
/**
 * 取得受變更影響的行範圍
 */
function getAffectedLineRange(document, changes) {
    if (changes.length === 0)
        return undefined;
    let minLine = changes[0].range.start.line;
    let maxLine = changes[0].range.end.line;
    let maxAffectedLineAfterChange = maxLine;
    for (const change of changes) {
        minLine = Math.min(minLine, change.range.start.line);
        maxLine = Math.max(maxLine, change.range.end.line);
        // 計算變更後影響的最大行號
        const linesAdded = (change.text.match(/\n/g) || []).length;
        const linesRemoved = change.range.end.line - change.range.start.line;
        maxAffectedLineAfterChange = Math.max(maxAffectedLineAfterChange, change.range.start.line + linesAdded);
    }
    // 稍微擴大範圍以確保包含粘貼或刪除影響的上下文
    const buffer = 5;
    const start = Math.max(0, minLine - buffer);
    // end 需要考慮變更後的最大行號，並確保不超過文件總行數
    const end = Math.min(document.lineCount - 1, Math.max(maxLine, maxAffectedLineAfterChange) + buffer);
    return { start, end };
}
// --- Activation & Event Handling ---
function activate(context) {
    console.log('Extension "indentation-based-numbering" is now active!');
    // --- Command Implementations ---
    const activateCommand = vscode.commands.registerCommand('indentation-based-numbering.activate', () => {
        isActive = true;
        vscode.window.showInformationMessage('Automatic Numbering Activated');
        // 立即觸發一次當前行的重新編號
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const position = editor.selection.active;
            const line = editor.document.lineAt(position.line);
            const indentation = getIndentation(line);
            // 初始激活時，處理整個文檔中對應縮排的行
            renumberLines(editor, indentation);
        }
    });
    const deactivateCommand = vscode.commands.registerCommand('indentation-based-numbering.deactivate', () => {
        isActive = false;
        // 清除可能存在的 debounce 計時器
        if (changeTimeout) {
            clearTimeout(changeTimeout);
            changeTimeout = undefined;
        }
        vscode.window.showInformationMessage('Automatic Numbering Deactivated');
        // 注意：停用時不會自動移除已有的編號
    });
    const renumberCommand = vscode.commands.registerCommand('indentation-based-numbering.renumber', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const position = editor.selection.active;
            const line = editor.document.lineAt(position.line);
            if (line.isEmptyOrWhitespace && position.line > 0) {
                // 如果當前行是空的，嘗試使用上一行的縮排
                const prevLine = editor.document.lineAt(position.line - 1);
                renumberLines(editor, getIndentation(prevLine));
            }
            else {
                renumberLines(editor, getIndentation(line));
            }
            vscode.window.setStatusBarMessage('Renumbered current layer.', 2000);
        }
        else {
            vscode.window.showWarningMessage('No active editor found.');
        }
    });
    const moveLeftCommand = vscode.commands.registerCommand('indentation-based-numbering.moveLeft', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            moveLines(editor, "left");
        }
    });
    const moveRightCommand = vscode.commands.registerCommand('indentation-based-numbering.moveRight', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            moveLines(editor, "right");
        }
    });
    const adjustLinesByLevelCommand = vscode.commands.registerCommand('indentation-based-numbering.adjustLinesByLevel', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            adjustLinesByLevel(editor);
        }
        else {
            vscode.window.showWarningMessage('No active editor found.');
        }
    });
    // --- Event Listener ---
    const textChangeListener = vscode.workspace.onDidChangeTextDocument(event => {
        if (!isActive || !vscode.window.activeTextEditor || event.document !== vscode.window.activeTextEditor.document) {
            // 如果未啟用、沒有活動編輯器或事件不是來自活動編輯器，則忽略
            return;
        }
        // 使用 debounce 防止過於頻繁的觸發
        if (changeTimeout) {
            clearTimeout(changeTimeout);
        }
        changeTimeout = setTimeout(async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || event.document !== editor.document) {
                changeTimeout = undefined;
                return;
            }
            const affectedRange = getAffectedLineRange(event.document, event.contentChanges);
            // 使用 change 事件範圍的起始行作為中心點判斷
            const changeStartLine = affectedRange?.start ?? editor.selection.active.line;
            let targetIndentation = undefined;
            const numberRegex = /^\s*\d+\.\s+/;
            const currentLine = editor.document.lineAt(changeStartLine);
            const currentIndent = getIndentation(currentLine);
            // --- Context Check (與之前相同) ---
            let prevNonEmptyLineNum = -1;
            if (changeStartLine > 0) { /* ... 查找 prevNonEmptyLineNum ... */
                for (let i = changeStartLine - 1; i >= 0; i--) {
                    if (!editor.document.lineAt(i).isEmptyOrWhitespace) {
                        prevNonEmptyLineNum = i;
                        break;
                    }
                }
            }
            if (prevNonEmptyLineNum !== -1) {
                const prevLine = editor.document.lineAt(prevNonEmptyLineNum);
                const prevIndent = getIndentation(prevLine);
                if (numberRegex.test(prevLine.text)) {
                    if (currentIndent === prevIndent) {
                        targetIndentation = prevIndent;
                        console.log(`Indents match previous numbered line ${prevNonEmptyLineNum}. Targeting: "${targetIndentation}"`);
                    }
                    else if (currentIndent.length > prevIndent.length) {
                        targetIndentation = currentIndent;
                        console.log(`Current line ${changeStartLine} indented more than previous numbered line ${prevNonEmptyLineNum}. Targeting new level: "${targetIndentation}"`);
                    }
                    else {
                        console.log(`Current line ${changeStartLine} indented less than previous numbered line ${prevNonEmptyLineNum}. Falling back.`);
                    }
                }
            }
            // --- Context Check End ---
            // --- Default/Fallback Logic (與之前相同) ---
            if (targetIndentation === undefined) {
                targetIndentation = currentIndent;
                if (currentLine.isEmptyOrWhitespace) { /* ... 向上查找 ... */
                    let foundIndent = null;
                    if (changeStartLine > 0) {
                        for (let i = changeStartLine - 1; i >= 0; i--) {
                            const line = editor.document.lineAt(i);
                            if (!line.isEmptyOrWhitespace) {
                                foundIndent = getIndentation(line);
                                break;
                            }
                        }
                    }
                    targetIndentation = foundIndent ?? "";
                    console.log(`Fallback: Current line ${changeStartLine} is empty. Used upward search. Targeting: "${targetIndentation}"`);
                }
                else {
                    console.log(`Fallback: Using current line ${changeStartLine}'s indentation. Targeting: "${targetIndentation}"`);
                }
            }
            // --- Default/Fallback Logic End ---
            // --- **修改：執行範圍限制的重新編號** ---
            if (targetIndentation !== undefined) {
                // **新增：查找邏輯區塊**
                const blockRange = findLogicalBlockRange(editor.document, changeStartLine, targetIndentation);
                if (blockRange) {
                    console.log(`Change affects block from line ${blockRange.start} to ${blockRange.end}`);
                    // **修改：調用返回 edits 的 renumberLines**
                    const allEdits = renumberLines(editor, targetIndentation); // 不再需要 affectedRange 參數
                    // **新增：過濾 edits 到區塊範圍內**
                    const filteredEdits = allEdits.filter(edit => edit.range.start.line >= blockRange.start && edit.range.end.line <= blockRange.end);
                    console.log(`Applying ${filteredEdits.length} filtered edits out of ${allEdits.length} total generated.`);
                    // **修改：應用過濾後的 edits**
                    if (filteredEdits.length > 0) {
                        try {
                            const success = await editor.edit(editBuilder => {
                                filteredEdits.forEach(edit => {
                                    // 範圍已經在 renumberLines 中驗證過
                                    editBuilder.replace(edit.range, edit.newText);
                                });
                                // 考慮自動編號是否需要合併撤銷步驟，暫時分開 (true, true)
                            }, { undoStopBefore: true, undoStopAfter: true });
                            if (!success) {
                                console.error("Filtered edit application returned false.");
                            }
                            else {
                                console.log("Filtered edits applied successfully.");
                            }
                        }
                        catch (error) {
                            console.error("Error applying filtered edits:", error);
                            // 避免向用戶顯示過多錯誤訊息
                            // vscode.window.showErrorMessage("An error occurred during auto-renumbering.");
                        }
                    }
                    else {
                        console.log("No edits needed within the affected block.");
                    }
                }
                else {
                    console.log(`Could not determine logical block for line ${changeStartLine} and indent "${targetIndentation}". No auto-renumbering applied.`);
                }
            }
            else {
                console.error("ERROR: Failed to determine target indentation!");
            }
            changeTimeout = undefined;
        }, DEBOUNCE_DELAY); // setTimeout 結束
    }); // textChangeListener 結束
    // context.subscriptions.push(...) // 保持不變
} // activate 函數結束
// --- Deactivation ---
function deactivate() {
    console.log('Extension "indentation-based-numbering" is now deactivated.');
    if (changeTimeout) {
        clearTimeout(changeTimeout); // 清理計時器
    }
    // VS Code 會自動處理 subscriptions 中的 Disposable 對象
    isActive = false; // 確保狀態被重設
}
//# sourceMappingURL=extension.js.map