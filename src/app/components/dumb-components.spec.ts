import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('display components', () => {
  const dirs = ['week-selector', 'calendar-grid', 'settings-panel', 'activity-panel'];

  for (const dir of dirs) {
    it(`${dir} has no dependency injection`, () => {
      const file = join(__dirname, dir, `${dir}.ts`);
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/\binject\s*\(/);
      expect(source).not.toMatch(/constructor\s*\(/);
      expect(source).not.toMatch(/@Inject|@Injectable/);
      expect(source).not.toMatch(/services\//);
      expect(readdirSync(join(__dirname, dir)).some((f) => f.endsWith('.ts'))).toBe(true);
    });
  }
});
