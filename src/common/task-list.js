import { NoteFormat } from "./note-format"

const BLOCK_DELIMITER_REGEX = /\n∞∞∞([a-z]+)(-a)?(?:;[^\n]+)*\n/g
const TASK_LINE_REGEX = /^([\t\f\v ]*-[\t\f\v ]*)\[( |x|X)\] (.*)$/

function lineNumberAt(content, index) {
    let lineNumber = 1
    for (let i = 0; i < index; i++) {
        if (content[i] === "\n") {
            lineNumber++
        }
    }
    return lineNumber
}

function taskLineText(line) {
    return line.endsWith("\r") ? line.slice(0, -1) : line
}

function isCheckedChar(char) {
    return char === " " || char === "x" || char === "X"
}

function lineStartOffset(content, lineNumber) {
    let offset = 0
    for (let line = 1; line < lineNumber && offset < content.length; line++) {
        const nextLine = content.indexOf("\n", offset)
        if (nextLine === -1) {
            return null
        }
        offset = nextLine + 1
    }
    return offset
}

function taskCheckedOffset(content, task) {
    const lineStart = lineStartOffset(content, task.lineNumber)
    if (lineStart !== null && Number.isInteger(task.checkedColumn)) {
        const offset = lineStart + task.checkedColumn
        if (isCheckedChar(content[offset])) {
            return offset
        }
    }
    if (Number.isInteger(task.checkedOffset) && isCheckedChar(content[task.checkedOffset])) {
        return task.checkedOffset
    }
    return null
}

export function extractTasksFromContent(content) {
    const matches = [...content.matchAll(BLOCK_DELIMITER_REGEX)]
    const tasks = []

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i]
        if (match[1] !== "markdown") {
            continue
        }

        const nextMatch = i < matches.length - 1 ? matches[i + 1] : null
        const blockContentStart = match.index + match[0].length
        const blockContentEnd = nextMatch ? nextMatch.index : content.length
        const blockContent = content.slice(blockContentStart, blockContentEnd)
        const blockStartLineNumber = lineNumberAt(content, blockContentStart)
        const lines = blockContent.split("\n")
        let blockLineStartOffset = 0

        for (let lineOffset = 0; lineOffset < lines.length; lineOffset++) {
            const line = taskLineText(lines[lineOffset])
            const taskMatch = TASK_LINE_REGEX.exec(line)
            const lineStart = blockContentStart + blockLineStartOffset
            blockLineStartOffset += lines[lineOffset].length + 1
            if (!taskMatch) {
                continue
            }

            const prefix = taskMatch[1]
            const checkedColumn = prefix.length + 1
            const textColumn = prefix.length + 4
            tasks.push({
                checked: taskMatch[2] === "x" || taskMatch[2] === "X",
                prefix,
                text: taskMatch[3],
                line,
                lineNumber: blockStartLineNumber + lineOffset,
                checkedColumn,
                checkedOffset: lineStart + checkedColumn,
                textColumn,
            })
        }
    }

    return tasks
}

export function extractTasksFromNoteData(data) {
    const note = NoteFormat.load(data)
    return extractTasksFromContent(note.content)
}

export function toggleTaskCheckedInContent(content, task) {
    const offset = taskCheckedOffset(content, task)
    if (offset === null) {
        throw new Error("Task checkbox position could not be found")
    }
    const checked = !(content[offset] === "x" || content[offset] === "X")
    return {
        content: content.slice(0, offset) + (checked ? "x" : " ") + content.slice(offset + 1),
        checked,
    }
}

export function toggleTaskInNoteData(data, task) {
    const note = NoteFormat.load(data)
    const result = toggleTaskCheckedInContent(note.content, task)
    note.content = result.content
    return {
        data: note.serialize(),
        checked: result.checked,
    }
}
