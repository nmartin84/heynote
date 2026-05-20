<script>
    import { toRaw } from "vue"
    import { mapActions, mapState, mapStores } from "pinia"

    import { extractReferencesToBuffer } from "@/src/common/references"
    import { useEditorCacheStore } from "@/src/stores/editor-cache"
    import { useHeynoteStore } from "@/src/stores/heynote-store"

    const pathSep = window.heynote.buffer.pathSeparator

    function fileBaseName(path) {
        const filename = path.split(pathSep).at(-1) || path
        return filename.endsWith(".txt") ? filename.slice(0, -4) : filename
    }

    function compareByName(a, b) {
        const nameCompare = a.name.localeCompare(b.name)
        return nameCompare === 0 ? a.buffer.localeCompare(b.buffer) : nameCompare
    }

    const MARKDOWN_TASK_LINE_REGEX = /^(\s*-\s*)\[( |x|X)\]\s?(.*)$/
    const BUFFER_LINK_INLINE_REGEX = /\[\[[^\]\n]+\]\]/g

    export default {
        props: {
            bottomPanel: {
                type: Boolean,
                default: false,
            },
        },

        data() {
            return {
                groups: [],
                errors: [],
                loading: false,
                refreshTimer: null,
                refreshRequestId: 0,
                disposed: false,
                openGroups: {},
                selectedRowKey: null,
            }
        },

        mounted() {
            this.refreshReferences()
        },

        beforeUnmount() {
            this.disposed = true
            window.clearTimeout(this.refreshTimer)
        },

        watch: {
            buffers: {
                deep: true,
                handler() {
                    this.scheduleRefresh()
                },
            },
            currentBufferPath() {
                this.scheduleRefresh(0)
            },
            referenceListRefreshId() {
                this.scheduleRefresh()
            },
        },

        computed: {
            ...mapStores(useHeynoteStore, useEditorCacheStore),
            ...mapState(useHeynoteStore, [
                "buffers",
                "currentBufferPath",
                "referenceListRefreshId",
            ]),

            referenceCount() {
                return this.groups.reduce((count, group) => count + group.references.length, 0)
            },

            bufferCount() {
                return this.groups.length
            },

            currentBufferName() {
                return this.bufferName(this.currentBufferPath)
            },

            rowItems() {
                const rows = []
                for (const group of this.groups) {
                    rows.push({
                        type: "buffer",
                        key: group.key,
                        group,
                    })
                    if (group.open) {
                        for (const reference of group.references) {
                            rows.push({
                                type: "reference",
                                key: reference.key,
                                group,
                                reference,
                            })
                        }
                    }
                }
                return rows
            },
        },

        methods: {
            ...mapActions(useHeynoteStore, [
                "focusEditor",
                "openBuffer",
            ]),

            bufferName(path) {
                const buffer = this.buffers[path]
                return buffer?.name || fileBaseName(path || "")
            },

            bufferDir(path) {
                const parts = path.split(pathSep)
                return parts.length > 1 ? parts.at(-2) : null
            },

            scheduleRefresh(delay = 150) {
                window.clearTimeout(this.refreshTimer)
                this.refreshTimer = window.setTimeout(() => {
                    this.refreshReferences()
                }, delay)
            },

            async cachedBufferContents(paths) {
                const contents = {}
                const cachedPaths = new Set()
                const pathSet = new Set(paths)
                const cache = toRaw(this.editorCacheStore.cache || {})
                const entries = Object.entries(cache).filter(([path]) => pathSet.has(path))

                await Promise.all(entries.map(async ([path, editor]) => {
                    await editor.contentLoadedPromise
                    contents[path] = editor.getContent()
                    cachedPaths.add(path)
                }))

                return { contents, cachedPaths }
            },

            async loadBufferContent(path) {
                const content = await window.heynote.buffer.load(path)
                await window.heynote.buffer.close(path)
                return content
            },

            async loadReferenceSources(paths) {
                const errors = []
                const { contents, cachedPaths } = await this.cachedBufferContents(paths)
                const uncachedPaths = paths.filter((path) => !cachedPaths.has(path))

                await Promise.all(uncachedPaths.map(async (path) => {
                    try {
                        contents[path] = await this.loadBufferContent(path)
                    } catch (error) {
                        errors.push({
                            path,
                            message: error.message || String(error),
                        })
                    }
                }))

                return { contents, errors }
            },

            async refreshReferences() {
                const requestId = ++this.refreshRequestId
                this.loading = true
                const targetPath = this.currentBufferPath
                const paths = Object.keys(this.buffers).filter((path) => path !== targetPath)

                try {
                    if (!targetPath) {
                        this.groups = []
                        this.errors = []
                        return
                    }

                    const { contents, errors } = await this.loadReferenceSources(paths)
                    const groups = []

                    for (const path of paths) {
                        if (contents[path] === undefined) {
                            continue
                        }

                        try {
                            const references = extractReferencesToBuffer(contents[path], path, targetPath, this.buffers)
                                .map((reference, index) => ({
                                    ...reference,
                                    key: `reference:${path}:${reference.lineNumber}:${reference.linkColumn}:${index}`,
                                }))

                            if (references.length === 0) {
                                continue
                            }

                            groups.push({
                                buffer: path,
                                key: `buffer:${path}`,
                                name: this.bufferName(path),
                                dir: this.bufferDir(path),
                                open: this.openGroups[path] !== false,
                                references,
                            })
                        } catch (error) {
                            errors.push({
                                path,
                                message: error.message || String(error),
                            })
                        }
                    }

                    if (requestId !== this.refreshRequestId || this.disposed) {
                        return
                    }

                    this.groups = groups.sort(compareByName)
                    this.errors = errors
                    this.ensureSelectedRowExists()
                } finally {
                    if (requestId === this.refreshRequestId && !this.disposed) {
                        this.loading = false
                    }
                }
            },

            setGroupOpen(group, open) {
                group.open = open
                this.openGroups = {
                    ...this.openGroups,
                    [group.buffer]: open,
                }
                this.ensureSelectedRowExists()
            },

            toggleGroup(group, focusTarget) {
                this.selectedRowKey = group.key
                this.setGroupOpen(group, !group.open)
                focusTarget?.focus({ preventScroll: true })
            },

            async openReference(reference, focusTarget) {
                this.selectedRowKey = reference.key
                this.openBuffer(reference.sourcePath, { focusEditor: false })
                await this.$nextTick()

                const editor = this.heynoteStore.currentEditor
                await editor?.contentLoadedPromise

                if (this.heynoteStore.currentBufferPath !== reference.sourcePath) {
                    return
                }

                editor?.setSelectionAtLineColumns(
                    reference.lineNumber,
                    reference.linkColumn,
                    reference.linkColumn + reference.linkText.length,
                )

                if (focusTarget?.isConnected) {
                    focusTarget.focus({ preventScroll: true })
                }
            },

            onReferencesFocus() {
                this.ensureSelectedRowExists(true)
            },

            selectedRowItem() {
                return this.rowItems.find((row) => row.key === this.selectedRowKey)
            },

            ensureSelectedRowExists(selectFirst = false) {
                if (this.rowItems.length === 0) {
                    this.selectedRowKey = null
                    return
                }
                if (this.selectedRowItem()) {
                    return
                }
                if (selectFirst) {
                    this.selectedRowKey = this.rowItems[0].key
                }
            },

            setSelectedRow(row) {
                if (!row) {
                    return
                }
                this.selectedRowKey = row.key
                this.$nextTick(() => this.scrollSelectedRowIntoView())
            },

            moveSelectedRow(direction) {
                if (this.rowItems.length === 0) {
                    return
                }
                this.ensureSelectedRowExists(true)
                const currentIndex = this.rowItems.findIndex((row) => row.key === this.selectedRowKey)
                const nextIndex = currentIndex === -1
                    ? 0
                    : Math.max(0, Math.min(this.rowItems.length - 1, currentIndex + direction))
                this.setSelectedRow(this.rowItems[nextIndex])
            },

            activateSelectedRow(focusTarget) {
                const row = this.selectedRowItem()
                if (!row) {
                    return
                }
                if (row.type === "buffer") {
                    this.toggleGroup(row.group, focusTarget)
                } else {
                    this.openReference(row.reference, focusTarget)
                }
            },

            onReferencesKeyDown(event) {
                if (event.key === "Escape") {
                    event.preventDefault()
                    this.focusEditor()
                    return
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault()
                    this.moveSelectedRow(event.key === "ArrowDown" ? 1 : -1)
                    return
                }
                if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                    const row = this.selectedRowItem()
                    if (!row || row.type !== "buffer") {
                        return
                    }
                    event.preventDefault()
                    this.setGroupOpen(row.group, event.key === "ArrowRight")
                    return
                }
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    this.activateSelectedRow(event.currentTarget)
                }
            },

            scrollSelectedRowIntoView() {
                const selectedRow = this.$el?.querySelector(".reference-list-row.selected")
                if (!selectedRow) {
                    return
                }
                selectedRow.scrollIntoView({
                    behavior: "auto",
                    block: "nearest",
                })
            },

            inlineParts(text) {
                const parts = []
                let cursor = 0
                for (const match of text.matchAll(BUFFER_LINK_INLINE_REGEX)) {
                    if (match.index > cursor) {
                        parts.push({
                            type: "text",
                            text: text.slice(cursor, match.index),
                        })
                    }
                    parts.push({
                        type: "buffer-link",
                        text: match[0],
                    })
                    cursor = match.index + match[0].length
                }
                if (cursor < text.length || parts.length === 0) {
                    parts.push({
                        type: "text",
                        text: text.slice(cursor),
                    })
                }
                return parts
            },

            markdownLines(reference) {
                return reference.blockText.split("\n").map((line, index) => {
                    const taskMatch = MARKDOWN_TASK_LINE_REGEX.exec(line)
                    if (taskMatch) {
                        return {
                            key: `${reference.key}:line:${index}`,
                            type: "task",
                            prefix: taskMatch[1],
                            checked: taskMatch[2] === "x" || taskMatch[2] === "X",
                            parts: this.inlineParts(taskMatch[3]),
                        }
                    }
                    return {
                        key: `${reference.key}:line:${index}`,
                        type: "text",
                        parts: this.inlineParts(line),
                    }
                })
            },
        },
    }
</script>

<template>
    <div :class="{ 'reference-list-container': true, 'bottom-panel': bottomPanel }">
        <header class="header">
            <div class="header-text">
                <div v-if="bottomPanel" class="panel-title">
                    References
                </div>
                <div v-if="referenceCount > 0 || loading" class="reference-summary">
                    <b>{{ referenceCount }}</b> references to <b>{{ currentBufferName }}</b> in <b>{{ bufferCount }}</b> buffers
                </div>
                <div v-if="errors.length > 0" class="reference-error">
                    Some buffers could not be scanned
                </div>
            </div>
            <button
                v-if="bottomPanel"
                class="close-button"
                type="button"
                title="Close References"
                aria-label="Close References"
                @click="$emit('close')"
            ></button>
        </header>
        <div
            class="reference-results"
            ref="references"
            tabindex="0"
            role="tree"
            @focus="onReferencesFocus"
            @keydown="onReferencesKeyDown"
        >
            <div v-if="loading && groups.length === 0" class="empty">
                Loading references...
            </div>
            <div v-else-if="groups.length === 0" class="empty">
                No references
            </div>
            <div
                v-for="group in groups"
                :key="group.buffer"
                class="reference-group"
            >
                <div
                    :class="{ buffer: true, open: group.open, 'reference-list-row': true, selected: selectedRowKey === group.key }"
                    :title="group.buffer"
                    role="treeitem"
                    :aria-expanded="String(group.open)"
                    :aria-selected="selectedRowKey === group.key ? 'true' : 'false'"
                    :data-row-key="group.key"
                    data-row-type="buffer"
                    @click="toggleGroup(group, $event.currentTarget.closest('.reference-results'))"
                >
                    <span class="name">{{ group.name }}</span>
                    <span v-if="group.dir" class="dir">{{ group.dir }}</span>
                    <span class="count">{{ group.references.length }}</span>
                </div>
                <div v-if="group.open" class="reference-items" role="group">
                    <div
                        v-for="reference in group.references"
                        :key="reference.key"
                        :class="{ reference: true, 'reference-list-row': true, selected: selectedRowKey === reference.key }"
                        role="treeitem"
                        :aria-selected="selectedRowKey === reference.key ? 'true' : 'false'"
                        :data-row-key="reference.key"
                        data-row-type="reference"
                        @click="openReference(reference, $event.currentTarget.closest('.reference-results'))"
                    >
                        <span class="indent-guide"></span>
                        <span class="line-number">{{ reference.blockLineNumber }}</span>
                        <span
                            v-if="reference.blockLanguage !== 'markdown'"
                            class="preview plain-preview"
                            :title="reference.blockText"
                        >{{ reference.blockText || "(empty block)" }}</span>
                        <span
                            v-else-if="reference.blockText"
                            class="preview markdown-preview"
                            :title="reference.blockText"
                        >
                            <span
                                v-for="line in markdownLines(reference)"
                                :key="line.key"
                                :class="{ 'markdown-line': true, 'task-line': line.type === 'task' }"
                            >
                                <template v-if="line.type === 'task'">
                                    <span class="task-prefix">{{ line.prefix }}</span>
                                    <span :class="{ 'task-checkbox': true, checked: line.checked }" aria-hidden="true"></span>
                                </template>
                                <span class="markdown-line-text">
                                    <template
                                        v-for="(part, index) in line.parts"
                                        :key="`${line.key}:part:${index}`"
                                    >
                                        <span v-if="part.type === 'buffer-link'" class="buffer-link-token">{{ part.text }}</span>
                                        <template v-else>{{ part.text }}</template>
                                    </template>
                                </span>
                            </span>
                        </span>
                        <span v-else class="preview plain-preview">(empty block)</span>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style lang="sass" scoped>
    .reference-list-container
        --reference-indent-guide-opacity: 0
        font-size: 13px
        padding: 0
        padding-top: 4px
        display: flex
        flex-direction: column
        height: 100%
        color: rgba(0,0,0, 0.7)
        +dark-mode
            color: rgba(255,255,255, 0.7)
        &:hover
            --reference-indent-guide-opacity: 1

        .header
            padding: 0 8px 0 10px
            flex-shrink: 0
            display: flex
            align-items: flex-start
            gap: 8px
            .header-text
                min-width: 0
                flex-grow: 1

        .panel-title
            margin-top: 7px
            font-weight: 600
            color: rgba(0,0,0, 0.78)
            +dark-mode
                color: rgba(255,255,255, 0.78)

        .reference-summary,
        .reference-error
            margin-top: 8px
            padding: 0 1px
            font-size: 12px
            line-height: 16px
            color: rgba(0,0,0, 0.55)
            +dark-mode
                color: rgba(255,255,255, 0.55)
            b
                color: rgba(0,0,0, 0.8)
                +dark-mode
                    color: rgba(255,255,255, 0.8)

        .reference-error
            color: #b42318
            +dark-mode
                color: #ffb4ab

        .close-button
            width: 22px
            height: 22px
            margin-top: 4px
            flex: 0 0 22px
            border: none
            border-radius: 3px
            background: transparent
            cursor: pointer
            position: relative
            color: rgba(0,0,0, 0.55)
            +dark-mode
                color: rgba(255,255,255, 0.55)
            &:hover
                background-color: rgba(0,0,0, 0.08)
                +dark-mode
                    background-color: rgba(255,255,255, 0.08)
            &:focus-visible
                outline: 2px solid #48b57e
                outline-offset: -1px
            &::before,
            &::after
                content: ""
                position: absolute
                left: 6px
                top: 10px
                width: 10px
                height: 1.5px
                background: currentColor
            &::before
                transform: rotate(45deg)
            &::after
                transform: rotate(-45deg)

        .reference-results
            padding-top: 8px
            overflow-y: auto
            height: 100%
            &:focus
                outline: none
                .reference-list-row.selected
                    outline: 1px solid #48b57e
                    outline-offset: -1px
                    z-index: 1

        .empty
            padding: 8px 10px
            font-size: 12px
            color: rgba(0,0,0, 0.55)
            +dark-mode
                color: rgba(255,255,255, 0.55)

    .reference-group
        .buffer
            cursor: pointer
            line-height: 20px
            padding: 2px 28px 2px 24px
            position: relative
            white-space: nowrap
            overflow: hidden
            text-overflow: ellipsis
            background-image: url('@/assets/icons/caret-right.svg')
            background-size: 12px
            background-repeat: no-repeat
            background-position: 9px 6px
            +dark-mode
                background-image: url('@/assets/icons/caret-right-white.svg')
            &.open
                background-image: url('@/assets/icons/caret-down.svg')
                +dark-mode
                    background-image: url('@/assets/icons/caret-down-white.svg')
            &:hover
                background-color: rgba(0,0,0, 0.06)
                +dark-mode
                    background-color: rgba(255,255,255, 0.08)
            .name
                vertical-align: middle
            .dir
                margin-left: 10px
                font-size: 0.9em
                vertical-align: middle
                opacity: 0.65
            .count
                position: absolute
                right: 10px
                top: 2px
                opacity: 0.6
                font-variant-numeric: tabular-nums

        .reference
            cursor: pointer
            display: grid
            grid-template-columns: 30px minmax(0, 1fr)
            gap: 7px
            line-height: 18px
            padding: 4px 10px 5px 34px
            position: relative
            color: rgba(0,0,0, 0.72)
            +dark-mode
                color: rgba(255,255,255, 0.72)
            &:hover
                background-color: rgba(0,0,0, 0.06)
                +dark-mode
                    background-color: rgba(255,255,255, 0.08)
            .indent-guide
                position: absolute
                top: 0
                bottom: 0
                left: 14px
                width: 1px
                opacity: var(--reference-indent-guide-opacity, 0)
                pointer-events: none
                background: rgba(0,0,0, 0.14)
                transition: opacity 80ms ease
                +dark-mode
                    background: rgba(255,255,255, 0.18)
            .line-number
                min-width: 0
                text-align: right
                font-variant-numeric: tabular-nums
                opacity: 0.55
                user-select: none
            .preview
                min-width: 0
                overflow: hidden
            .plain-preview
                white-space: pre-wrap
                display: -webkit-box
                -webkit-line-clamp: 4
                -webkit-box-orient: vertical
            .markdown-preview
                display: block
                max-height: 72px
                line-height: 18px
                white-space: normal
            .markdown-line
                display: flex
                min-width: 0
                overflow: hidden
                text-overflow: ellipsis
                white-space: pre
            .task-prefix
                flex: 0 0 auto
                white-space: pre
            .task-checkbox
                width: 12px
                height: 12px
                box-sizing: border-box
                border: 1px solid currentColor
                border-radius: 2px
                flex: 0 0 12px
                position: relative
                top: 3px
                margin: 0 7px 0 2px
                opacity: 0.82
                &.checked
                    background: #1f8deb
                    border-color: #1f8deb
                    +dark-mode
                        background: #2d9bf0
                        border-color: #2d9bf0
                    &::after
                        content: ""
                        position: absolute
                        left: 3px
                        top: 0px
                        width: 4px
                        height: 8px
                        border: solid #fff
                        border-width: 0 2px 2px 0
                        transform: rotate(45deg)
            .markdown-line-text
                min-width: 0
                overflow: hidden
                text-overflow: ellipsis
                white-space: pre
            .buffer-link-token
                color: #2f7d59
                text-decoration: underline
                text-underline-offset: 2px
                +dark-mode
                    color: #a3be8c

    :global(.left-panel:hover) .reference-list-container
        --reference-indent-guide-opacity: 1

    .reference-list-container.bottom-panel
        padding-top: 0
        border-top: 1px solid var(--tab-bar-border-bottom-color)
        background: #f4f8f4
        +dark-mode
            background: #1e222a
        .reference-results
            padding-top: 5px
        .reference-group
            .buffer
                padding-top: 3px
                padding-bottom: 3px
            .reference
                grid-template-columns: 38px minmax(0, 1fr)
                padding-top: 5px
                padding-bottom: 6px
</style>
