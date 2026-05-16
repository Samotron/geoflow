/**
 * Playwright tests for the ThreeDTab in the GeoFlow React SPA.
 *
 * These tests verify the 3-D viewer's structure, tool interactions, and
 * behaviour before and after loading a real AGS fixture file.
 *
 * The SPA is served by `vite preview` (see playwright.config.mjs).
 * AGS fixture: tests/fixtures/ags/browser_explorer.ags
 *   → 3 boreholes: BH01 (E=100, N=200), BH02 (E=115, N=212), TP01 (E=130, N=225)
 *   → GEOL unit keys (first word of GEOL_DESC): BROWN, GREY, TOPSOIL, WHITE, MADE
 *     (surfaces are null — only one occurrence each — but model is not null)
 */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE  = join(__dirname, '../fixtures/ags/browser_explorer.ags');
const BASE     = '/geoflow/';

// ── Helpers ───────────────────────────────────────────────────────────────────

type Page = import('@playwright/test').Page;

async function uploadFixture(page: Page): Promise<void> {
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.getByText('browser_explorer.ags')).toBeVisible();
}

async function goTo3D(page: Page): Promise<void> {
  await page.getByRole('button', { name: '3D View' }).click();
}

// ── App shell ─────────────────────────────────────────────────────────────────

test('app shell: GeoFlow header, drop-zone and 3D View tab are visible', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByRole('heading', { name: 'GeoFlow' })).toBeVisible();
  await expect(page.getByText('Drop a file')).toBeVisible();
  await expect(page.getByRole('button', { name: '3D View' })).toBeVisible();
});

// ── 3D tab — no file loaded ───────────────────────────────────────────────────

test.describe('3D tab — no file loaded', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await goTo3D(page);
  });

  test('shows "Load an AGS file" overlay when no file is loaded', async ({ page }) => {
    await expect(page.getByText('Load an AGS file to enable 3-D view')).toBeVisible();
  });

  test('toolbar buttons are visible with correct accessibility titles', async ({ page }) => {
    await expect(page.getByTitle('Select borehole (click in 3-D)')).toBeVisible();
    await expect(page.getByTitle('Add cross-section (draw A→B on plan)')).toBeVisible();
    await expect(page.getByTitle('Clear all sections')).toBeVisible();
  });

  test('Controls panel contains Surface opacity and Vertical exaggeration sliders', async ({ page }) => {
    await expect(page.getByText('Surface opacity')).toBeVisible();
    await expect(page.getByText('Vertical exaggeration')).toBeVisible();
    const ranges = page.locator('input[type="range"]');
    await expect(ranges.first()).toBeVisible();
    expect(await ranges.count()).toBeGreaterThanOrEqual(2);
  });

  test('Cross Sections panel shows draw button and empty-state hint', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: '+ Draw new section (A→B on plan)' }),
    ).toBeVisible();
    await expect(
      page.getByText('No sections yet — use the ⊘ tool or button above'),
    ).toBeVisible();
  });

  test('Borehole Log panel shows placeholder text before any borehole is selected', async ({ page }) => {
    await expect(
      page.getByText('Click a borehole in the 3-D view to show its log'),
    ).toBeVisible();
  });
});

// ── 3D tab — after file upload ────────────────────────────────────────────────

test.describe('3D tab — browser_explorer.ags loaded', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await uploadFixture(page);
    await goTo3D(page);
  });

  test('"Load an AGS file" overlay is absent after a valid file is loaded', async ({ page }) => {
    await expect(page.getByText('Load an AGS file to enable 3-D view')).not.toBeAttached();
  });

  test('"Could not build 3-D model" error is NOT shown for a file with valid coordinates', async ({ page }) => {
    await expect(page.getByText('Could not build 3-D model')).not.toBeAttached();
  });

  test('Controls panel shows a "Geological units" section with unit toggle buttons', async ({ page }) => {
    // buildGeo3DModel uses first-word-of-GEOL_DESC as unit key when GEOL_GEOL is absent.
    // browser_explorer.ags descs → keys: "BROWN", "GREY", "TOPSOIL", "WHITE", "MADE".
    await expect(page.getByText('Geological units')).toBeVisible();
    for (const key of ['BROWN', 'GREY', 'TOPSOIL', 'WHITE', 'MADE']) {
      await expect(page.locator('button').filter({ hasText: key }).first()).toBeVisible();
    }
  });

  test('Plan View canvas is attached and has non-zero dimensions', async ({ page }) => {
    // The plan view is the last <canvas> in the DOM (the Three.js renderer may add
    // one too, but the plan canvas is always rendered last in the right panel).
    const plan = page.locator('canvas').last();
    await expect(plan).toBeAttached();
    const box = await plan.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });

  test('file name appears in the drop zone after upload', async ({ page }) => {
    await expect(page.getByText('browser_explorer.ags')).toBeVisible();
  });
});

// ── Tool interactions ─────────────────────────────────────────────────────────

test.describe('3D tab — tool and section interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await uploadFixture(page);
    await goTo3D(page);
  });

  test('clicking the ⊘ section tool shows A-point placement hint', async ({ page }) => {
    await page.getByTitle('Add cross-section (draw A→B on plan)').click();
    await expect(
      page.getByText('Click plan view (right panel) to place point A'),
    ).toBeVisible();
  });

  test('switching back to ⊙ select tool removes the section hint', async ({ page }) => {
    await page.getByTitle('Add cross-section (draw A→B on plan)').click();
    await page.getByTitle('Select borehole (click in 3-D)').click();
    await expect(
      page.getByText('Click plan view (right panel) to place point A'),
    ).not.toBeAttached();
  });

  test('"+ Draw new section" button also activates section mode', async ({ page }) => {
    await page.getByRole('button', { name: '+ Draw new section (A→B on plan)' }).click();
    await expect(
      page.getByText('Click plan view (right panel) to place point A'),
    ).toBeVisible();
  });

  test('clicking ✕ clear button does not crash (no sections to clear)', async ({ page }) => {
    await page.getByTitle('Clear all sections').click();
    // No assertion needed beyond not throwing; "No sections yet" should remain
    await expect(
      page.getByText('No sections yet — use the ⊘ tool or button above'),
    ).toBeVisible();
  });
});

// ── Right-panel collapsible panels ────────────────────────────────────────────

test.describe('3D tab — collapsible right panels', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await goTo3D(page);
  });

  test('all four panel headings are present', async ({ page }) => {
    for (const heading of ['Controls', 'Cross Sections', 'Borehole Log', 'Plan View']) {
      await expect(page.getByRole('button', { name: new RegExp(heading) })).toBeVisible();
    }
  });

  test('collapsing Controls panel hides the Surface opacity label', async ({ page }) => {
    const controlsBtn = page.getByRole('button', { name: /^[▾▸]\s*Controls$/ });
    await controlsBtn.click();
    await expect(page.getByText('Surface opacity')).not.toBeVisible();
  });

  test('re-expanding Controls panel restores the Surface opacity label', async ({ page }) => {
    const controlsBtn = page.getByRole('button', { name: /^[▾▸]\s*Controls$/ });
    await controlsBtn.click(); // collapse
    await controlsBtn.click(); // expand
    await expect(page.getByText('Surface opacity')).toBeVisible();
  });
});
