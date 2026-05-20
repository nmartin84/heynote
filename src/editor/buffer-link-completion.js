import { autocompletion } from "@codemirror/autocomplete"

const BUFFER_LINK_CONTEXT_REGEX = /\[\[([^\]\n]*)$/
const MAX_COMPLETIONS = 50

function normalize(value) {
    return (value || "").trim().toLowerCase()
}

function fileBaseName(path) {
    const filename = (path || "").split(/[\\/]/).at(-1) || path
    return filename.endsWith(".txt") ? filename.slice(0, -4) : filename
}

function canUseBufferNameAsLink(name, nameCounts) {
    return name && !/[\[\]\n]/.test(name) && nameCounts.get(normalize(name)) === 1
}

function completionMatchScore(candidate, query) {
    if (!query) {
        return 0
    }

    const haystacks = [
        normalize(candidate.name),
        normalize(candidate.baseName),
        normalize(candidate.path),
    ]
    const startsWithIndex = haystacks.findIndex((value) => value.startsWith(query))
    if (startsWithIndex !== -1) {
        return startsWithIndex
    }
    const includesIndex = haystacks.findIndex((value) => value.includes(query))
    return includesIndex === -1 ? null : includesIndex + 3
}

function applyBufferLinkCompletion(insertText) {
    return (view, completion, from, to) => {
        const line = view.state.doc.lineAt(to)
        const hasClosingBrackets = view.state.sliceDoc(to, Math.min(line.to, to + 2)) === "]]"
        const suffix = hasClosingBrackets ? "" : "]]"
        const insert = insertText + suffix

        view.dispatch({
            changes: {
                from,
                to,
                insert,
            },
            selection: {
                anchor: from + insert.length,
            },
        })
    }
}

function buildBufferCandidates(editor) {
    const buffers = editor.notesStore.buffers || {}
    const nameCounts = new Map()

    for (const [path, metadata] of Object.entries(buffers)) {
        const name = metadata?.name || fileBaseName(path)
        const key = normalize(name)
        nameCounts.set(key, (nameCounts.get(key) || 0) + 1)
    }

    return Object.entries(buffers)
        .filter(([path]) => path !== editor.path)
        .map(([path, metadata]) => {
            const baseName = fileBaseName(path)
            const name = metadata?.name || baseName
            const insertText = canUseBufferNameAsLink(name, nameCounts) ? name : path
            return {
                path,
                name,
                baseName,
                insertText,
            }
        })
}

function bufferLinkCompletionSource(editor) {
    return (context) => {
        const line = context.state.doc.lineAt(context.pos)
        const textBeforeCursor = line.text.slice(0, context.pos - line.from)
        const match = textBeforeCursor.match(BUFFER_LINK_CONTEXT_REGEX)

        if (!match) {
            return null
        }

        const query = normalize(match[1])
        const from = context.pos - match[1].length
        const options = buildBufferCandidates(editor)
            .map((candidate) => ({
                candidate,
                score: completionMatchScore(candidate, query),
            }))
            .filter((item) => item.score !== null)
            .sort((a, b) => {
                if (a.score !== b.score) {
                    return a.score - b.score
                }
                return a.candidate.name.localeCompare(b.candidate.name)
                    || a.candidate.path.localeCompare(b.candidate.path)
            })
            .slice(0, MAX_COMPLETIONS)
            .map(({ candidate }) => ({
                label: candidate.name,
                detail: candidate.path,
                type: "text",
                apply: applyBufferLinkCompletion(candidate.insertText),
            }))

        if (options.length === 0) {
            return null
        }

        return {
            from,
            to: context.pos,
            options,
            validFor: /^[^\]\n]*$/,
            filter: false,
        }
    }
}

export function bufferLinkCompletions(editor) {
    return autocompletion({
        override: [bufferLinkCompletionSource(editor)],
        activateOnTyping: true,
        activateOnTypingDelay: 0,
        interactionDelay: 0,
        maxRenderedOptions: MAX_COMPLETIONS,
    })
}
