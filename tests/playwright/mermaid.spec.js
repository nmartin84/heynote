import { test, expect } from "@playwright/test";
import { HeynotePage } from "./test-utils.js";

let heynotePage

test.beforeEach(async ({ page }) => {
    heynotePage = new HeynotePage(page)
    await heynotePage.goto()
});

test("renders mermaid block preview beside source", async ({ page }) => {
    await heynotePage.setContent(`
∞∞∞mermaid
graph TD
    A[Start] --> B[Done]
`)

    const preview = page.locator(".heynote-mermaid-preview")
    await expect(preview).toBeVisible()
    await expect(preview.locator("svg")).toBeVisible({ timeout: 10000 })
    await expect(page.locator(".cm-line.heynote-mermaid-source-line").first()).toBeVisible()

    const sourceBox = await page.locator(".cm-line.heynote-mermaid-source-line").first().boundingBox()
    const previewBox = await preview.boundingBox()
    expect(previewBox.x).toBeGreaterThan(sourceBox.x + sourceBox.width - 2)
})

test("copies rendered mermaid svg", async ({ page }) => {
    await heynotePage.setContent(`
∞∞∞mermaid
sequenceDiagram
    Alice->>Bob: Hello
`)

    const preview = page.locator(".heynote-mermaid-preview")
    await expect(preview.locator("svg")).toBeVisible({ timeout: 10000 })
    await preview.getByRole("button", { name: "Copy Mermaid diagram as SVG" }).click()

    await expect(preview.locator(".heynote-mermaid-status")).toHaveText("Copied")
    await expect.poll(async () => {
        return await page.evaluate(() => navigator.clipboard.readText())
    }).toContain("<svg")
})
