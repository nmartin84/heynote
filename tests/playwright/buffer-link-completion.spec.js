import { expect, test } from "@playwright/test"
import { HeynotePage } from "./test-utils.js"

function createBufferContent(name, content = "") {
    return JSON.stringify({
        formatVersion: "2.0.0",
        name,
    }) + `\n∞∞∞text-a;created=2026-01-01T00:00:00.000Z\n${content}`
}

function installLibraryState() {
    const notes = {
        "scratch.txt": createBufferContent("Scratch"),
        "project.txt": createBufferContent("Project Note", "Project body"),
        "archive.txt": createBufferContent("Archive", "Archive body"),
    }
    return { notes }
}

test.describe("buffer link completion", () => {
    test.beforeEach(async ({ page }) => {
        const state = installLibraryState()
        await page.addInitScript((seed) => {
            localStorage.clear()
            for (const [path, content] of Object.entries(seed.notes)) {
                localStorage.setItem(`heynote-library__${path}`, content)
            }
        }, state)

        const heynotePage = new HeynotePage(page)
        await heynotePage.goto()
    })

    test("suggests matching buffers after typing an opening buffer link", async ({ page }) => {
        await page.locator(".cm-editor").click()
        await page.keyboard.type("[[Pro")

        const tooltip = page.locator(".cm-tooltip-autocomplete")
        await expect(tooltip).toBeVisible()
        await expect(tooltip.locator("li", { hasText: "Project Note" })).toBeVisible()
        await expect(tooltip.locator("li", { hasText: "Archive" })).toHaveCount(0)

        const selectedColors = await tooltip.locator("li[aria-selected]").first().evaluate((element) => {
            const style = window.getComputedStyle(element)
            return {
                color: style.color,
                backgroundColor: style.backgroundColor,
            }
        })
        expect(selectedColors.color).toBe("rgb(255, 255, 255)")
        expect(selectedColors.backgroundColor).toBe("rgb(72, 181, 126)")

        await tooltip.locator("li", { hasText: "Project Note" }).click()

        await expect.poll(async () => {
            const heynotePage = new HeynotePage(page)
            return await heynotePage.getBlockContent(0)
        }).toBe("[[Project Note]]")
    })

    test("accepts a matching buffer suggestion with enter", async ({ page }) => {
        await page.locator(".cm-editor").click()
        await page.keyboard.type("[[Pro")

        const tooltip = page.locator(".cm-tooltip-autocomplete")
        await expect(tooltip).toBeVisible()
        await expect(tooltip.locator("li[aria-selected]", { hasText: "Project Note" })).toBeVisible()

        await page.keyboard.press("Enter")

        await expect.poll(async () => {
            const heynotePage = new HeynotePage(page)
            return await heynotePage.getBlockContent(0)
        }).toBe("[[Project Note]]")
    })
})
