import { describe, it, expect } from 'vitest';
// @ts-ignore: No type definitions for 'uuid'
import { v4 as uuidv4 } from 'uuid';
describe('UUID Utility', () => {
    it('generates a valid UUID v4', () => {
        const id = uuidv4();
        expect(id).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
    });
});
//# sourceMappingURL=uuid.test.js.map