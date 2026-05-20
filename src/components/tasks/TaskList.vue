<script>
    import { toRaw } from "vue"
    import { mapActions, mapState, mapStores } from "pinia"

    import { extractTasksFromNoteData, toggleTaskInNoteData } from "@/src/common/task-list"
    import { useEditorCacheStore } from "@/src/stores/editor-cache"
    import { useHeynoteStore } from "@/src/stores/heynote-store"
    import { useSettingsStore } from "@/src/stores/settings-store"

    const pathSep = window.heynote.buffer.pathSeparator

    function fileBaseName(path) {
        const filename = path.split(pathSep).at(-1) || path
        return filename.endsWith(".txt") ? filename.slice(0, -4) : filename
    }

    function compareByName(a, b) {
        const nameCompare = a.name.localeCompare(b.name)
        return nameCompare === 0 ? a.buffer.localeCompare(b.buffer) : nameCompare
    }

    export default {
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
            this.refreshTasks()
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
            taskListRefreshId() {
                this.scheduleRefresh()
            },
        },

        computed: {
            ...mapStores(useHeynoteStore, useEditorCacheStore),
            ...mapStores(useSettingsStore),
            ...mapState(useHeynoteStore, [
                "buffers",
                "currentBufferPath",
                "taskListRefreshId",
            ]),

            editorFontStyle() {
                return {
                    fontFamily: this.settingsStore.settings.fontFamily || window.heynote.defaultFontFamily,
                    fontSize: `${this.settingsStore.settings.fontSize || window.heynote.defaultFontSize}px`,
                }
            },

            taskCount() {
                return this.groups.reduce((count, group) => count + group.tasks.length, 0)
            },

            openTaskCount() {
                return this.groups.reduce((count, group) => (
                    count + group.tasks.filter((task) => !task.checked).length
                ), 0)
            },

            bufferCount() {
                return this.groups.length
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
                        for (const task of group.tasks) {
                            rows.push({
                                type: "task",
                                key: task.key,
                                group,
                                task,
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
                return buffer?.name || fileBaseName(path)
            },

            bufferDir(path) {
                const parts = path.split(pathSep)
                return parts.length > 1 ? parts.at(-2) : null
            },

            scheduleRefresh(delay = 150) {
                window.clearTimeout(this.refreshTimer)
                this.refreshTimer = window.setTimeout(() => {
                    this.refreshTasks()
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

            async loadTaskSources(paths) {
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

            async refreshTasks() {
                const requestId = ++this.refreshRequestId
                this.loading = true
                const paths = Object.keys(this.buffers)

                try {
                    const { contents, errors } = await this.loadTaskSources(paths)
                    const groups = []

                    for (const path of paths) {
                        if (contents[path] === undefined) {
                            continue
                        }

                        try {
                            const tasks = extractTasksFromNoteData(contents[path]).map((task, index) => ({
                                ...task,
                                buffer: path,
                                key: `task:${path}:${task.lineNumber}:${task.textColumn}:${index}`,
                            }))

                            if (tasks.length === 0) {
                                continue
                            }

                            groups.push({
                                buffer: path,
                                key: `buffer:${path}`,
                                name: this.bufferName(path),
                                dir: this.bufferDir(path),
                                open: this.openGroups[path] !== false,
                                active: path === this.currentBufferPath,
                                tasks,
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

            async openTask(task, focusTarget) {
                this.selectedRowKey = task.key
                this.openBuffer(task.buffer, { focusEditor: false })
                await this.$nextTick()

                const editor = this.heynoteStore.currentEditor
                await editor?.contentLoadedPromise

                if (this.heynoteStore.currentBufferPath !== task.buffer) {
                    return
                }

                if (task.text.length > 0) {
                    editor?.setSelectionAtLineColumns(task.lineNumber, task.textColumn, task.line.length)
                } else {
                    editor?.setCursorPositionAtLineColumn(task.lineNumber, task.textColumn)
                }

                if (focusTarget?.isConnected) {
                    focusTarget.focus({ preventScroll: true })
                }
            },

            taskCheckedPosition(editor, task) {
                const state = editor.view.state
                const line = state.doc.line(Math.max(1, Math.min(task.lineNumber, state.doc.lines)))
                const offset = line.from + task.checkedColumn
                const current = state.doc.sliceString(offset, offset + 1)
                if (current !== " " && current !== "x" && current !== "X") {
                    throw new Error("Task checkbox position could not be found")
                }
                return {
                    offset,
                    checked: !(current === "x" || current === "X"),
                }
            },

            async toggleCachedTask(editor, task) {
                await editor.contentLoadedPromise
                const position = this.taskCheckedPosition(editor, task)
                editor.view.dispatch({
                    changes: {
                        from: position.offset,
                        to: position.offset + 1,
                        insert: position.checked ? "x" : " ",
                    },
                    userEvent: "input",
                })
                await editor.save()
                return position.checked
            },

            async toggleStoredTask(task) {
                const data = await window.heynote.buffer.load(task.buffer)
                try {
                    const result = toggleTaskInNoteData(data, task)
                    await window.heynote.buffer.save(task.buffer, result.data)
                    return result.checked
                } finally {
                    await window.heynote.buffer.close(task.buffer)
                }
            },

            async toggleTaskChecked(task, focusTarget) {
                this.selectedRowKey = task.key
                try {
                    const editor = toRaw(this.editorCacheStore.cache?.[task.buffer])
                    task.checked = editor
                        ? await this.toggleCachedTask(editor, task)
                        : await this.toggleStoredTask(task)
                    this.heynoteStore.notifyTaskListChanged()
                    this.scheduleRefresh(0)
                } catch (error) {
                    this.errors = [
                        ...this.errors,
                        {
                            path: task.buffer,
                            message: error.message || String(error),
                        },
                    ]
                }
                focusTarget?.focus({ preventScroll: true })
            },

            taskTextParts(text) {
                const parts = []
                const pattern = /(https?:\/\/[^\s)]+|\[\[[^\]\n]+\]\])/gi
                let cursor = 0
                for (const match of text.matchAll(pattern)) {
                    if (match.index > cursor) {
                        parts.push({
                            text: text.slice(cursor, match.index),
                            link: false,
                        })
                    }
                    parts.push({
                        text: match[0],
                        link: true,
                    })
                    cursor = match.index + match[0].length
                }
                if (cursor < text.length) {
                    parts.push({
                        text: text.slice(cursor),
                        link: false,
                    })
                }
                return parts.length ? parts : [{ text, link: false }]
            },

            onTasksFocus() {
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
                    this.openTask(row.task, focusTarget)
                }
            },

            onTasksKeyDown(event) {
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
                const selectedRow = this.$el?.querySelector(".task-list-row.selected")
                if (!selectedRow) {
                    return
                }
                selectedRow.scrollIntoView({
                    behavior: "auto",
                    block: "nearest",
                })
            },
        },
    }
</script>

<template>
    <div class="task-list-container">
        <header class="header">
            <div v-if="taskCount > 0 || loading" class="task-summary">
                <b>{{ openTaskCount }}</b> open / <b>{{ taskCount }}</b> total in <b>{{ bufferCount }}</b> buffers
            </div>
            <div v-if="errors.length > 0" class="task-error">
                Some buffers could not be scanned
            </div>
        </header>
        <div
            class="task-results"
            ref="tasks"
            tabindex="0"
            role="tree"
            @focus="onTasksFocus"
            @keydown="onTasksKeyDown"
        >
            <div v-if="loading && groups.length === 0" class="empty">
                Loading tasks...
            </div>
            <div v-else-if="groups.length === 0" class="empty">
                No tasks
            </div>
            <div
                v-for="group in groups"
                :key="group.buffer"
                class="task-group"
            >
                <div
                    :class="{ buffer: true, open: group.open, active: group.active, 'task-list-row': true, selected: selectedRowKey === group.key }"
                    :title="group.buffer"
                    role="treeitem"
                    :aria-expanded="String(group.open)"
                    :aria-selected="selectedRowKey === group.key ? 'true' : 'false'"
                    :data-row-key="group.key"
                    data-row-type="buffer"
                    @click="toggleGroup(group, $event.currentTarget.closest('.task-results'))"
                >
                    <span class="name">{{ group.name }}</span>
                    <span v-if="group.dir" class="dir">{{ group.dir }}</span>
                    <span class="count">{{ group.tasks.length }}</span>
                </div>
                <div v-if="group.open" class="task-items" role="group">
                    <div
                        v-for="task in group.tasks"
                        :key="task.key"
                        :class="{ task: true, checked: task.checked, 'task-list-row': true, selected: selectedRowKey === task.key }"
                        role="treeitem"
                        :aria-selected="selectedRowKey === task.key ? 'true' : 'false'"
                        :data-row-key="task.key"
                        data-row-type="task"
                        @click="openTask(task, $event.currentTarget.closest('.task-results'))"
                        :style="editorFontStyle"
                    >
                        <span class="indent-guide"></span>
                        <span class="task-prefix" aria-hidden="true">{{ task.prefix }}</span>
                        <span class="checkbox-slot">
                            <input
                                type="checkbox"
                                class="checkbox"
                                tabindex="-1"
                                :checked="task.checked"
                                :aria-label="task.checked ? 'Mark task incomplete' : 'Mark task complete'"
                                @click.stop="toggleTaskChecked(task, $event.currentTarget.closest('.task-results'))"
                            />
                        </span>
                        <span class="text" :title="task.text">
                            <template v-if="task.text">
                                <template
                                    v-for="(part, index) in taskTextParts(task.text)"
                                    :key="index"
                                >
                                    <span v-if="part.link" class="markdown-link">{{ part.text }}</span>
                                    <template v-else>{{ part.text }}</template>
                                </template>
                            </template>
                            <template v-else>(empty task)</template>
                        </span>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style lang="sass" scoped>
    .task-list-container
        --task-indent-guide-opacity: 0
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
            --task-indent-guide-opacity: 1

        .header
            padding: 0 8px 0 10px
            flex-shrink: 0

        .task-summary,
        .task-error
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

        .task-error
            color: #b42318
            +dark-mode
                color: #ffb4ab

        .task-results
            padding-top: 8px
            overflow-y: auto
            height: 100%
            &:focus
                outline: none
                .task-list-row.selected
                    outline: 1px solid #48b57e
                    outline-offset: -1px
                    z-index: 1

        .empty
            padding: 8px 10px
            font-size: 12px
            color: rgba(0,0,0, 0.55)
            +dark-mode
                color: rgba(255,255,255, 0.55)

    .task-group
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
            &.active
                background-color: #d4ded9
                +dark-mode
                    background-color: #244233
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

        .task
            cursor: pointer
            display: flex
            align-items: flex-start
            gap: 0
            line-height: 1.5
            padding: 2px 10px 2px 34px
            white-space: normal
            position: relative
            color: rgba(0,0,0, 0.72)
            +dark-mode
                color: rgba(255,255,255, 0.72)
            &:hover
                background-color: rgba(0,0,0, 0.06)
                +dark-mode
                    background-color: rgba(255,255,255, 0.08)
            &.checked
                color: rgba(0,0,0, 0.62)
                +dark-mode
                    color: rgba(255,255,255, 0.62)
            .indent-guide
                position: absolute
                top: 0
                bottom: 0
                left: 14px
                width: 1px
                opacity: var(--task-indent-guide-opacity, 0)
                pointer-events: none
                background: rgba(0,0,0, 0.14)
                transition: opacity 80ms ease
                +dark-mode
                    background: rgba(255,255,255, 0.18)
            .task-prefix
                flex: 0 0 auto
                white-space: pre
            .checkbox-slot
                display: inline-block
                width: 4ch
                height: 1.5em
                flex: 0 0 4ch
                position: relative
                .checkbox
                    margin: 0
                    padding: 0
                    position: absolute
                    top: 0.15em
                    left: 0.25em
                    width: 1.1em
                    height: 1.1em
                    cursor: pointer
                    accent-color: #1f8deb
                    &:focus-visible
                        outline: 2px auto #48b57e
                        outline-offset: 2px
            .text
                min-width: 0
                overflow-wrap: anywhere
                word-break: normal
            .markdown-link
                text-decoration: underline
                text-underline-position: under

    :global(.left-panel:hover) .task-list-container
        --task-indent-guide-opacity: 1
</style>
