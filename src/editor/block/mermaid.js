import mermaid from "mermaid"
import { Decoration, EditorView, WidgetType, layer } from "@codemirror/view"
import { StateField } from "@codemirror/state"
import { foldState } from "@codemirror/language"

import { blockState } from "./block.js"
import { isBlockFolded } from "../fold-gutter.js"


const MERMAID_PREVIEW_MIN_HEIGHT = 180
const MERMAID_PREVIEW_MIN_WIDTH = 180
const mermaidSourceLine = Decoration.line({ class: "heynote-mermaid-source-line" })

let renderCounter = 0


class MermaidSpacer extends WidgetType {
    constructor(height) {
        super()
        this.height = height
    }

    eq(other) {
        return other.height === this.height
    }

    toDOM() {
        const wrap = document.createElement("div")
        wrap.className = "heynote-mermaid-spacer"
        wrap.style.height = `${this.height}px`
        return wrap
    }

    ignoreEvent() {
        return true
    }
}


function mermaidBlockDecorations(state) {
    const decorations = []
    const lineHeight = 18

    for (const block of state.field(blockState)) {
        if (block.language.name !== "mermaid" || isBlockFolded(state, block)) {
            continue
        }

        const firstLine = state.doc.lineAt(block.content.from)
        const lastLine = state.doc.lineAt(block.content.to)

        for (let lineNo = firstLine.number; lineNo <= lastLine.number; lineNo++) {
            const line = state.doc.line(lineNo)
            decorations.push(mermaidSourceLine.range(line.from))
        }

        const estimatedSourceHeight = (lastLine.number - firstLine.number + 1) * lineHeight
        const spacerHeight = Math.max(0, MERMAID_PREVIEW_MIN_HEIGHT - estimatedSourceHeight)
        if (spacerHeight > 0) {
            decorations.push(Decoration.widget({
                widget: new MermaidSpacer(spacerHeight),
                block: true,
                side: -1,
            }).range(block.content.to))
        }
    }

    return Decoration.set(decorations, true)
}


const mermaidBlockDecorationsField = StateField.define({
    create(state) {
        return mermaidBlockDecorations(state)
    },

    update(decorations, transaction) {
        if (
            transaction.docChanged ||
            transaction.startState.field(foldState, false) !== transaction.state.field(foldState, false)
        ) {
            return mermaidBlockDecorations(transaction.state)
        }

        return decorations
    },

    provide(field) {
        return EditorView.decorations.from(field)
    },
})


function getVisibleMermaidMarkers(view) {
    const markers = []
    const editorWidth = view.scrollDOM.clientWidth
    const left = Math.floor(editorWidth / 2)
    const width = Math.max(MERMAID_PREVIEW_MIN_WIDTH, editorWidth - left - 8)
    const isDark = view.state.facet(EditorView.darkTheme)

    function rangesOverlap(range1, range2) {
        return range1.from <= range2.to && range2.from <= range1.to
    }

    for (const block of view.state.field(blockState)) {
        if (
            block.language.name !== "mermaid" ||
            isBlockFolded(view.state, block) ||
            !view.visibleRanges.some(range => rangesOverlap(block.content, range))
        ) {
            continue
        }

        const fromCoordsTop = view.lineBlockAt(block.content.from)?.top
        const toLine = view.state.doc.lineAt(block.content.to)
        const toLinePos = toLine.length === 0 ? toLine.from : Math.max(block.content.from, Math.min(block.content.to, toLine.to))
        const toCoordsBottom = view.lineBlockAt(toLinePos)?.bottom

        if (fromCoordsTop === undefined || toCoordsBottom === undefined) {
            continue
        }

        markers.push(new MermaidPreviewMarker({
            blockFrom: block.range.from,
            source: view.state.sliceDoc(block.content.from, block.content.to).trim(),
            isDark,
            left,
            top: fromCoordsTop - 2,
            width,
            height: Math.max(MERMAID_PREVIEW_MIN_HEIGHT, (toCoordsBottom - fromCoordsTop) + 12),
        }))
    }

    return markers
}


class MermaidPreviewMarker {
    constructor({ blockFrom, source, isDark, left, top, width, height }) {
        this.blockFrom = blockFrom
        this.source = source
        this.isDark = isDark
        this.left = left
        this.top = top
        this.width = width
        this.height = height
    }

    eq(other) {
        return (
            other.blockFrom === this.blockFrom &&
            other.source === this.source &&
            other.isDark === this.isDark &&
            other.left === this.left &&
            other.top === this.top &&
            other.width === this.width &&
            other.height === this.height
        )
    }

    draw() {
        const wrap = document.createElement("div")
        wrap.className = "heynote-mermaid-preview"
        this.adjust(wrap)
        this.render(wrap)
        return wrap
    }

    update(wrap, previous) {
        this.adjust(wrap)
        if (
            previous.blockFrom !== this.blockFrom ||
            previous.source !== this.source ||
            previous.isDark !== this.isDark
        ) {
            this.render(wrap)
        }
        return true
    }

    adjust(wrap) {
        wrap.style.left = `${this.left}px`
        wrap.style.top = `${this.top}px`
        wrap.style.width = `${this.width}px`
        wrap.style.height = `${this.height}px`
    }

    render(wrap) {
        wrap.innerHTML = ""
        wrap.dataset.blockFrom = String(this.blockFrom)

        const toolbar = document.createElement("div")
        toolbar.className = "heynote-mermaid-toolbar"

        const status = document.createElement("span")
        status.className = "heynote-mermaid-status"

        const copyButton = document.createElement("button")
        copyButton.type = "button"
        copyButton.className = "heynote-mermaid-action"
        copyButton.textContent = "Copy"
        copyButton.title = "Copy SVG"
        copyButton.setAttribute("aria-label", "Copy Mermaid diagram as SVG")
        copyButton.disabled = true

        const saveButton = document.createElement("button")
        saveButton.type = "button"
        saveButton.className = "heynote-mermaid-action"
        saveButton.textContent = "Save"
        saveButton.title = "Save SVG"
        saveButton.setAttribute("aria-label", "Save Mermaid diagram as SVG")
        saveButton.disabled = true

        toolbar.append(status, copyButton, saveButton)

        const body = document.createElement("div")
        body.className = "heynote-mermaid-preview-body"

        wrap.append(toolbar, body)

        const stopEditorMouseHandling = event => {
            event.preventDefault()
            event.stopPropagation()
        }
        copyButton.addEventListener("mousedown", stopEditorMouseHandling)
        saveButton.addEventListener("mousedown", stopEditorMouseHandling)

        copyButton.addEventListener("click", async event => {
            event.preventDefault()
            event.stopPropagation()
            await copyMermaidSvg(wrap.dataset.svg || "", status)
        })
        saveButton.addEventListener("click", async event => {
            event.preventDefault()
            event.stopPropagation()
            await saveMermaidSvg(wrap.dataset.svg || "", status)
        })

        renderMermaidDiagram({
            wrap,
            body,
            status,
            copyButton,
            saveButton,
            source: this.source,
            isDark: this.isDark,
        })
    }
}


function setStatus(status, text, timeout = 1600) {
    status.textContent = text
    if (timeout) {
        window.setTimeout(() => {
            if (status.textContent === text) {
                status.textContent = ""
            }
        }, timeout)
    }
}


function formatMermaidError(error) {
    if (!error) {
        return "Unable to render diagram"
    }
    return error.str || error.message || String(error)
}


async function renderMermaidDiagram({ wrap, body, status, copyButton, saveButton, source, isDark }) {
    delete wrap.dataset.svg
    copyButton.disabled = true
    saveButton.disabled = true

    if (!source) {
        body.className = "heynote-mermaid-preview-body empty"
        body.textContent = "Empty Mermaid diagram"
        return
    }

    const renderToken = crypto.randomUUID()
    wrap.dataset.renderToken = renderToken
    body.className = "heynote-mermaid-preview-body loading"
    body.textContent = "Rendering..."

    try {
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: isDark ? "dark" : "default",
        })

        const { svg, bindFunctions } = await mermaid.render(`heynote-mermaid-${++renderCounter}`, source)
        if (wrap.dataset.renderToken !== renderToken) {
            return
        }

        body.className = "heynote-mermaid-preview-body rendered"
        body.innerHTML = svg
        bindFunctions?.(body)
        wrap.dataset.svg = svg
        copyButton.disabled = false
        saveButton.disabled = false
    } catch (error) {
        if (wrap.dataset.renderToken !== renderToken) {
            return
        }

        body.className = "heynote-mermaid-preview-body error"
        body.textContent = formatMermaidError(error)
        setStatus(status, "Render error", 0)
    }
}


async function copyMermaidSvg(svg, status) {
    if (!svg) {
        return
    }

    try {
        if (navigator.clipboard?.write && window.ClipboardItem) {
            const clipboardItems = {
                "text/plain": new Blob([svg], { type: "text/plain" }),
            }
            if (ClipboardItem.supports?.("image/svg+xml")) {
                clipboardItems["image/svg+xml"] = new Blob([svg], { type: "image/svg+xml" })
            }
            await navigator.clipboard.write([new ClipboardItem(clipboardItems)])
        } else {
            await navigator.clipboard.writeText(svg)
        }
        setStatus(status, "Copied")
    } catch (error) {
        try {
            await navigator.clipboard.writeText(svg)
            setStatus(status, "Copied")
        } catch {
            setStatus(status, "Copy failed", 2200)
        }
    }
}


function downloadSvg(svg, filename) {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}


async function saveMermaidSvg(svg, status) {
    if (!svg) {
        return
    }

    const filename = "mermaid-diagram.svg"
    try {
        if (window.heynote?.diagram?.saveSvg) {
            const savedPath = await window.heynote.diagram.saveSvg({
                defaultPath: filename,
                svg,
            })
            if (savedPath) {
                setStatus(status, "Saved")
            }
            return
        }

        downloadSvg(svg, filename)
        setStatus(status, "Saved")
    } catch (error) {
        setStatus(status, "Save failed", 2200)
    }
}


const mermaidPreviewLayer = layer({
    above: true,
    class: "heynote-mermaid-preview-layer",

    mount(layerElement) {
        layerElement.removeAttribute("aria-hidden")
    },

    markers(view) {
        return getVisibleMermaidMarkers(view)
    },

    update(update) {
        return (
            update.docChanged ||
            update.viewportChanged ||
            update.geometryChanged ||
            update.startState.field(foldState, false) !== update.state.field(foldState, false) ||
            update.startState.facet(EditorView.darkTheme) !== update.state.facet(EditorView.darkTheme)
        )
    },
})


export const mermaidBlock = [
    mermaidBlockDecorationsField,
    mermaidPreviewLayer,
]
