import { expect, test } from "@playwright/test"
import { DEFAULT_LEFT_PANEL_WIDTH } from "@/src/common/constants.js"
import { HeynotePage } from "./test-utils.js"

const DELIMITER = "\n" + "\u221e".repeat(3)

function textBlock(lines) {
    return `${DELIMITER}text-a;created=2026-01-01T00:00:00.000Z\n${lines.join("\n")}`
}

function markdownBlock(lines) {
    return `${DELIMITER}markdown;created=2026-01-01T00:00:00.000Z\n${lines.join("\n")}`
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
        "scratch.txt": createBufferContent("Scratch", textBlock([
            "Scratch target",
        ])),
        "project.txt": createBufferContent("Project", textBlock([
            "Discuss [[Scratch]] during planning",
            "Keep this second line in the same block",
        ])),
        "folder-a/other.txt": createBufferContent("Other", markdownBlock([
            "Path backlink context",
            "- [x] Reviewed [[scratch.txt|scratch home]]",
            "- [ ] Follow up",
        ])),
        "unrelated.txt": createBufferContent("Unrelated", textBlock([
            "This points at [[Missing]] and should not show",
        ])),
    }
    return { settings, notes }
}

test.describe("sidebar references", () => {
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
        await page.locator(".status .status-block.references").click()
        await expect(page.locator(".reference-list-container")).toBeVisible()
    })

    test("lists inbound buffer links and opens a selected source block", async ({ page }) => {
        await expect(page.locator(".references-panel")).toBeVisible()
        await expect(page.locator(".status .status-block.references")).toHaveClass(/active/)
        await expect(page.locator(".reference-summary")).toContainText("2 references to Scratch in 2 buffers")

        const projectGroup = page.locator(".reference-group", { hasText: "Project" })
        const otherGroup = page.locator(".reference-group", { hasText: "Other" })
        await expect(projectGroup.locator(".reference")).toContainText("Discuss [[Scratch]] during planning")
        await expect(projectGroup.locator(".reference")).toContainText("Keep this second line in the same block")
        await expect(otherGroup.locator(".reference")).toContainText("Path backlink context")
        await expect(otherGroup.locator(".reference")).toContainText("Reviewed [[scratch.txt|scratch home]]")
        await expect(otherGroup.locator(".reference").first().locator(".task-checkbox")).toHaveCount(2)
        await expect(otherGroup.locator(".reference").first().locator(".task-checkbox.checked")).toHaveCount(1)
        await expect(otherGroup.locator(".reference").first().locator(".buffer-link-token")).toContainText("[[scratch.txt|scratch home]]")
        await expect(otherGroup.locator(".reference").first()).not.toContainText("[x]")
        await expect(page.locator(".reference-list-container .reference", { hasText: "Missing" })).toHaveCount(0)

        await projectGroup.locator(".reference").click()

        await expect(page.locator(".reference-results")).toBeFocused()
        await expect.poll(async () => page.evaluate(() => window._heynote_editor.path)).toBe("project.txt")
        await expect.poll(async () => {
            return await page.evaluate(() => {
                const editor = window._heynote_editor
                const selection = editor.view.state.selection.main
                return editor.view.state.doc.sliceString(selection.from, selection.to)
            })
        }).toBe("[[Scratch]]")
    })

    test("toggles the bottom references panel from the status bar and close button", async ({ page }) => {
        await expect(page.locator(".references-panel")).toBeVisible()

        await page.locator(".references-panel .close-button").click()
        await expect(page.locator(".references-panel")).toHaveCount(0)
        await expect(page.locator(".status .status-block.references")).not.toHaveClass(/active/)

        await page.locator(".status .status-block.references").click()
        await expect(page.locator(".references-panel")).toBeVisible()
    })

    test("refreshes references from cached editor content", async ({ page }) => {
        const updatedProject = createBufferContent("Project", textBlock([
            "Fresh unsaved backlink to [[Scratch]]",
        ]))

        await page.evaluate(() => window._heynote_editor.notesStore.openBuffer("project.txt", { focusEditor: false }))
        await expect.poll(async () => page.evaluate(() => window._heynote_editor.path)).toBe("project.txt")
        await page.evaluate((content) => {
            return window._heynote_editor.contentLoadedPromise.then(() => window._heynote_editor.setContent(content))
        }, updatedProject)

        await page.evaluate(() => window._heynote_editor.notesStore.openBuffer("scratch.txt", { focusEditor: false }))
        await expect.poll(async () => page.evaluate(() => window._heynote_editor.path)).toBe("scratch.txt")

        await expect(page.locator(".reference-list-container .reference", { hasText: "Fresh unsaved backlink" })).toBeVisible()
        await expect(page.locator(".reference-list-container .reference", { hasText: "Discuss [[Scratch]]" })).toHaveCount(0)
    })
})
