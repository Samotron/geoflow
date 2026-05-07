import { expect, test } from '@playwright/test';

test('loads the explorer shell and key tabs', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'GeoFlow' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Data' })).toHaveClass(/active/);
  await expect(page.getByRole('button', { name: 'Graph' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Validation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Map' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Logs' })).toBeVisible();
});

test('data tab drills from LOCA_ID into the borehole summary view', async ({ page }) => {
  await page.goto('/');

  await page.locator('.grp-list-item').filter({ hasText: 'GEOL' }).first().click();
  await page.getByRole('button', { name: 'BH01' }).first().click();

  await expect(page.getByText('Borehole Summary')).toBeVisible();
  await expect(page.getByText('Linked AGS records')).toBeVisible();
  await expect(page.getByText('Final depth: 12.5')).toBeVisible();
  await expect(page.getByText('Geology: 2 rows')).toBeVisible();
  await expect(page.getByText('Samples: 2')).toBeVisible();
  await expect(page.getByText('SPT: 1')).toBeVisible();
});

test('graph tab shows semantic borehole relationships', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Graph' }).click();

  await expect(page.getByRole('heading', { name: 'Knowledge Graph' })).toBeVisible();
  await expect(page.getByText('Relationship view for BH01')).toBeVisible();
  await expect(page.locator('.onto-group-section').getByText('InvestigationPoint', { exact: true })).toBeVisible();
  await expect(page.locator('.onto-group-section').getByText('DepthInterval', { exact: true })).toBeVisible();
  await expect(page.locator('.onto-group-section').getByText('LithologyObservation', { exact: true })).toBeVisible();
  await expect(page.locator('.onto-group-section').getByText('MaterialFacet', { exact: true })).toBeVisible();
});

test('graph tab supports the GEOL_LEG semantic query', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Graph' }).click();

  const input = page.getByPlaceholder('GEOL_LEG code, e.g. CL');
  await input.fill('CL');

  await expect(page.getByText('Matches: BH01')).toBeVisible();
});

test('graph tab can switch to whole-file semantic view', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Graph' }).click();
  await page.getByText('Whole file', { exact: true }).click();

  await expect(page.getByText('Relationship view for the whole file')).toBeVisible();
  await expect(page.locator('.file-info-bar').getByText('3 boreholes', { exact: true })).toBeVisible();
  await expect(page.locator('.onto-group-section').getByText('InvestigationPoint', { exact: true })).toBeVisible();
  await expect(page.locator('.onto-group-section').getByText('LithologyObservation', { exact: true })).toBeVisible();
});

test('logs tab renders the borehole log workflow', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Logs' }).click();
  await page.getByText('BH01', { exact: true }).click();

  await expect(page.getByText('Borehole Log')).toBeVisible();
  await expect(page.getByText('Browser Explorer Fixture')).toBeVisible();
  await expect(page.getByText('Ground Level (mOD)')).toBeVisible();
});

test('validation tab can run validation and select a borehole preview', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Validation' }).click();

  await page.getByRole('button', { name: /Run Validation/ }).click();
  await expect(page.getByText(/No issues found|error|warning|info/i).first()).toBeVisible();

  await page.locator('.bh-btn').filter({ hasText: 'BH01' }).click();
  await expect(page.locator('.bh-preview')).toBeVisible();
  await expect(page.locator('.bh-preview-meta')).toContainText('BH01');
});

test('map tab exposes section drawing controls and 3d toggle', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Map' }).click();

  await expect(page.getByRole('button', { name: 'Draw Section Line' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show 3D View' })).toBeVisible();
  await expect(page.getByText(/Project Map/i)).toBeVisible();
  await expect(page.getByText(/Leaflet \+ OpenStreetMap/i)).toBeVisible();

  await page.getByRole('button', { name: 'Show 3D View' }).click();
  await expect(page.getByText(/That Open 3D Viewer/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide 3D View' })).toBeVisible();
});

test('enhance tab can parse a single description and batch enhance the file', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Enhance' }).click();

  const input = page.getByPlaceholder(/Firm to stiff greyish brown sandy CLAY/i);
  await input.fill('Firm grey sandy CLAY');
  await page.getByRole('button', { name: 'Parse' }).click();

  await expect(page.getByText(/Confidence/i)).toBeVisible();
  await expect(page.getByText(/material/i)).toBeVisible();

  await page.getByRole('button', { name: 'Enhance file' }).click();
  await expect(page.getByRole('heading', { name: 'GEOL descriptions' })).toBeVisible();
  await expect(page.getByText('BH01', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Brown CLAY/i)).toBeVisible();
});

test('rules tab renders the rule pack editor and validation controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Rules' }).click();

  await expect(page.getByText('Rule Pack Editor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Validate with Pack' })).toBeVisible();
  await expect(page.getByText(/Edit your rules above/i)).toBeVisible();
});
