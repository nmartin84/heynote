import { expect, test } from "@playwright/test"
import { DEFAULT_LEFT_PANEL_WIDTH } from "@/src/common/constants.js"
import { HeynotePage } from "./test-utils.js"

const DELIMITER = "\n" + "\u221e".repeat(3)

function markdownBlock(lines) {
    return `${DELIMITER}markdown;created=2026-01-01T00:00:00.000Z\n${lines.join("\n")}`
}

function textBlock(lines) {
    return `${DELIMITER}text-a;created=2026-01-01T00:00:00.000Z\n${lines.join("\n")}`
}

function createBufferContent(name, blocks = "") {
    return JSON.stringify({
        formatVersion: "2.0.0",
        name,
    }) + blocks
}

function installLibraryState() {
    const settings = {
        showLeftPanel: true,
        leftPanelWidth: DEFAULT_LEFT_PANEL_WIDTH,
    }
    const notes = {
        "scratch.txt": createBufferContent("Scratch", [
            markdownBlock([
                "- [ ] Scratch open task",
                "- [x] Scratch done task",
            ]),
        ].join("")),
        "folder-a/project.txt": createBufferContent("Project Note", [
            markdownBlock([
                "Project notes",
                "- [ ] Project open task [[Pyspark]]",
            ]),
            textBlock([
                "- [ ] Ignored text task",
            ]),
        ].join("")),
        "folder-a/other.txt": createBufferContent("Other Note", markdownBlock([
            "No tasks here",
        ])),
    }
    return { settings, notes }
}

test.describe("sidebar tasks", () => {
    test.beforeEach(async ({ page }) => {
        const state = installLibraryState()
        await page.addInitScript((seed) => {
            localStorage.clear()
            localStorage.setItem("settings", JSON.stringify(seed.settings))
            for (const [path, content] of Object.entries(seed.notes)) {
                localStorage.setItem(`heynote-library__${path}`, content)
            }
        }, state)

        const heynotePage = new HeynotePage(page)
        await heynotePage.goto()
        await page.getByRole("button", { name: "Tasks" }).click()
        await expect(page.locator(".task-list-container")).toBeVisible()
    })

    test("lists tasks grouped by buffer name and opens a selected task", async ({ page }) => {
        await expect(page.getByRole("button", { name: "Tasks" })).toHaveClass(/selected/)
        await expect(page.locator(".task-summary")).toContainText("2 open / 3 total in 2 buffers")

        const scratchGroup = page.locator(".task-group", { hasText: "Scratch" })
        const projectGroup = page.locator(".task-group", { hasText: "Project Note" })
        await expect(scratchGroup.locator(".task")).toHaveCount(2)
        await expect(projectGroup.locator(".task")).toHaveCount(1)
        await expect(page.locator(".task-list-container .task", { hasText: "Ignored text task" })).toHaveCount(0)

        const projectTask = page.locator(".task-list-container .task", { hasText: "Project open task" })
        await expect(projectTask.locator(".task-prefix")).toHaveText("- ")
        await expect(projectTask.locator("input[type=checkbox]")).not.toBeChecked()
        await expect(projectTask.locator(".markdown-link", { hasText: "[[Pyspark]]" })).toBeVisible()

        await projectTask.click()

        await expect(page.locator(".task-results")).toBeFocused()
        await expect.poll(async () => page.evaluate(() => window._heynote_editor.path)).toBe("folder-a/project.txt")
        await expect.poll(async () => {
            return await page.evaluate(() => {
                const editor = window._heynote_editor
                const selection = editor.view.state.selection.main
                return editor.view.state.doc.sliceString(selection.from, selection.to)
            })
        }).toBe("Project open task [[Pyspark]]")
    })

    test("toggles task checkboxes without opening the buffer", async ({ page }) => {
        const projectTask = page.locator(".task-list-container .task", { hasText: "Project open task" })
        const checkbox = projectTask.locator("input[type=checkbox]")

        await checkbox.click()

        await expect(checkbox).toBeChecked()
        await expect(page.locator(".task-summary")).toContainText("1 open / 3 total in 2 buffers")
        await expect.poll(async () => {
            return await page.evaluate(async () => await window.heynote.buffer.load("folder-a/project.txt"))
        }).toContain("- [x] Project open task [[Pyspark]]")
        await expect.poll(async () => page.evaluate(() => window._heynote_editor.path)).toBe("scratch.txt")
    })

    test("refreshes from cached editor content", async ({ page }) => {
        const updatedScratch = createBufferContent("Scratch", markdownBlock([
            "- [ ] Live task from editor",
        ]))

        await page.evaluate(async (content) => {
            await window._heynote_editor.setContent(content)
        }, updatedScratch)

        await expect(page.locator(".task-list-container .task", { hasText: "Live task from editor" })).toBeVisible()
        await expect(page.locator(".task-list-container .task", { hasText: "Scratch open task" })).toHaveCount(0)
    })

    test("wraps long task text", async ({ page }) => {
        const longTask = "This is a long markdown task that should wrap across multiple lines in the left panel instead of being hidden behind an ellipsis"
        const updatedScratch = createBufferContent("Scratch", markdownBlock([
            `- [ ] ${longTask}`,
        ]))

        await page.evaluate(async (content) => {
            await window._heynote_editor.setContent(content)
        }, updatedScratch)

        const task = page.locator(".task-list-container .task", { hasText: longTask })
        await expect(task).toBeVisible()

        const wraps = await task.evaluate((element) => {
            const lineHeight = parseFloat(getComputedStyle(element).lineHeight)
            return element.getBoundingClientRect().height > lineHeight * 1.8
        })
        expect(wraps).toBe(true)
    })
})
