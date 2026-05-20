import { NoteFormat } from "./note-format"

const BLOCK_DELIMITER_REGEX = /\n∞∞∞([a-z]+)(-a)?(?:;[^\n]+)*\n/g
export const BUFFER_LINK_REGEX = /\[\[([^\]\n]+)\]\]/g

function normalizeLinkKey(value) {
    return (value || "").trim().toLowerCase()
}

function pathParts(path) {
    return (path || "").split(/[\\/]/)
}

function fileBaseName(path) {
    const filename = pathParts(path).at(-1) || path
    return filename.endsWith(".txt") ? filename.slice(0, -4) : filename
}

function withoutTxt(path) {
    return path.endsWith(".txt") ? path.slice(0, -4) : path
}

function addAlias(index, alias, path) {
    const key = normalizeLinkKey(alias)
    if (!key) {
        return
    }
    if (index.has(key) && index.get(key) !== path) {
        index.set(key, null)
        return
    }
    index.set(key, path)
}

export function parseBufferLinkTarget(rawLink) {
    const value = rawLink || ""
    const separatorIndex = value.indexOf("|")
    return (separatorIndex === -1 ? value : value.slice(0, separatorIndex)).trim()
}

export function buildBufferLinkIndex(buffers) {
    const index = new Map()
    for (const [path, metadata] of Object.entries(buffers || {})) {
        addAlias(index, fileBaseName(path), path)
        addAlias(index, metadata?.name, path)
    }
    for (const path of Object.keys(buffers || {})) {
        index.set(normalizeLinkKey(path), path)
        index.set(normalizeLinkKey(withoutTxt(path)), path)
        index.set(normalizeLinkKey(path.replaceAll("\\", "/")), path)
        index.set(normalizeLinkKey(withoutTxt(path.replaceAll("\\", "/"))), path)
    }
    return index
}

export function resolveBufferLinkTarget(rawLink, bufferIndexOrBuffers) {
    const target = parseBufferLinkTarget(rawLink)
    const index = bufferIndexOrBuffers instanceof Map
        ? bufferIndexOrBuffers
        : buildBufferLinkIndex(bufferIndexOrBuffers)
    return index.get(normalizeLinkKey(target)) || null
}

function lineNumberAt(content, index) {
    let lineNumber = 1
    for (let i = 0; i < index; i++) {
        if (content[i] === "\n") {
            lineNumber++
        }
    }
    return lineNumber
}

function lineStartAt(content, index) {
    return content.lastIndexOf("\n", Math.max(0, index - 1)) + 1
}

function lineEndAt(content, index) {
    const end = content.indexOf("\n", index)
    return end === -1 ? content.length : end
}

function displayBlockContent(content) {
    return content.replace(/\s+$/g, "")
}

export function extractReferencesToBuffer(data, sourcePath, targetPath, buffers) {
    const note = NoteFormat.load(data)
    const content = note.content
    const matches = [...content.matchAll(BLOCK_DELIMITER_REGEX)]
    const bufferIndex = buildBufferLinkIndex(buffers)
    const references = []

    for (let i = 0; i < matches.length; i++) {
        const blockMatch = matches[i]
        const nextBlockMatch = i < matches.length - 1 ? matches[i + 1] : null
        const blockContentStart = blockMatch.index + blockMatch[0].length
        const blockContentEnd = nextBlockMatch ? nextBlockMatch.index : content.length
        const blockContent = content.slice(blockContentStart, blockContentEnd)
        const blockLineNumber = lineNumberAt(content, blockContentStart)

        BUFFER_LINK_REGEX.lastIndex = 0
        let linkMatch = BUFFER_LINK_REGEX.exec(blockContent)
        while (linkMatch) {
            const linkTarget = resolveBufferLinkTarget(linkMatch[1], bufferIndex)
            if (linkTarget === targetPath) {
                const linkStart = blockContentStart + linkMatch.index
                const lineStart = lineStartAt(content, linkStart)
                const lineEnd = lineEndAt(content, linkStart)

                references.push({
                    sourcePath,
                    targetPath,
                    linkText: linkMatch[0],
                    targetText: parseBufferLinkTarget(linkMatch[1]),
                    line: content.slice(lineStart, lineEnd),
                    lineNumber: lineNumberAt(content, linkStart),
                    linkColumn: linkStart - lineStart,
                    blockText: displayBlockContent(blockContent),
                    blockLineNumber,
                    blockLanguage: blockMatch[1],
                })
            }
            linkMatch = BUFFER_LINK_REGEX.exec(blockContent)
        }
    }

    return references
}
