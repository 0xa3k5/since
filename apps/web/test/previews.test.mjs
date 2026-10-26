// The home page previews (src/components/landing/previews) copy the app's own wording. These tests fail when a
// string they show no longer exists in the desktop renderer, so a preview can't keep saying something the app doesn't.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../../desktop/renderer/', import.meta.url);
const app = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
const preview = (name) => readFileSync(new URL(`../src/components/landing/previews/${name}.astro`, import.meta.url), 'utf8');

const strings = {
  SincePreview: ['since your checkpoint', 'Mark since', 'CI passing', '`CI ${ci} on ${res.base}`'],
  ReviewPreview: ["'Stuck'", "'Ready to merge'", "'CI failing'"],
  FixPromptPreview: ['`Fix prompt for #${pr.number}`', 'Why it’s stuck', "'Copy prompt'", "'Prompt copied'"],
  MergePlanPreview: ["'Merged'", "'Ready'"],
  CleanUpPreview: ['`Cleaned up: ${done}`', "' deleted'", "label: 'Undo'", '`${dir === \'undo\' ? \'Undid\' : \'Redid\'} “${label}”`', "`Clean up ${chosen.length}`"],
};

for (const [name, list] of Object.entries(strings)) {
  test(`${name} uses the app's wording`, () => {
    preview(name); // the preview still exists
    for (const s of list) assert.ok(app.includes(s), `"${s}" is no longer in apps/desktop/renderer; update ${name}`);
  });
}
