import { Decoration, ViewPlugin } from "@codemirror/view"
import { MatchDecorator } from "@codemirror/view"

import { resolveBufferLinkTarget } from "../common/references.js"


const modChar = window.heynote.platform.isMac ? "⌘" : "Ctrl"
const eventKeyModAttribute = window.heynote.platform.isMac ? "metaKey" : "ctrlKey"

const linkMatcher = new MatchDecorator({
    regexp: /https?:\/\/[^\s\)]+/gi,
    decoration: match => {
        return Decoration.mark({
            class: "heynote-link",
            attributes: {title: `${modChar} + Click to open link`},
        })
    },
})

const bufferLinkMatcher = new MatchDecorator({
    regexp: /\[\[([^\]\n]+)\]\]/g,
    decoration: match => {
        return Decoration.mark({
            class: "heynote-buffer-link",
            attributes: {
                title: `${modChar} + Click to open buffer link`,
                "data-buffer-link-target": match[1],
            },
        })
    },
})

const externalLinks = ViewPlugin.fromClass(class {
    links

    constructor(view) {
        this.links = linkMatcher.createDeco(view)
    }
    update(update) {
        this.links = linkMatcher.updateDeco(update, this.links)
    }
}, {
    decorations: instance => instance.links,
    eventHandlers: {
        click: (e, view) => {
            let target = e.target
            if (target.closest(".heynote-link")?.classList.contains("heynote-link") && e[eventKeyModAttribute]) {
                let linkEl = document.createElement("a")
                linkEl.href = target.textContent
                linkEl.target = "_blank"
                linkEl.click()
                linkEl.remove()
            }
        }
    },
})

const bufferLinks = (editor) => ViewPlugin.fromClass(class {
    links

    constructor(view) {
        this.links = bufferLinkMatcher.createDeco(view)
    }
    update(update) {
        this.links = bufferLinkMatcher.updateDeco(update, this.links)
    }
}, {
    decorations: instance => instance.links,
    eventHandlers: {
        click: (e, view) => {
            const target = e.target.closest(".heynote-buffer-link")
            if (!target?.classList.contains("heynote-buffer-link") || !e[eventKeyModAttribute]) {
                return
            }

            const linkTarget = target.dataset.bufferLinkTarget
            const targetPath = resolveBufferLinkTarget(linkTarget, editor.notesStore.buffers)
            if (targetPath) {
                e.preventDefault()
                editor.notesStore.openBuffer(targetPath)
            }
        }
    },
})

export const links = (editor) => [
    externalLinks,
    bufferLinks(editor),
]
