import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { tokenizeLine } from "./lexer.js";

// Helper to escape double quotes for serialization
const escape = (s: string) => s.replace(/"/g, '""');

describe("lexer property tests", () => {
  it("lexer round-trip for valid fields", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { minLength: 1 }), (fields) => {
        // Construct an AGS line: "field1","field2",...
        
        // Filter out fields with null bytes or other weirdness
        const safeFields = fields.map(f => f.replace(/\x00/g, ''));
        
        // If all fields are empty, the line might still be empty if we don't quote them correctly.
        // But we are quoting them: ""
        const line = safeFields.map(f => `"${escape(f)}"`).join(',');
        const result = tokenizeLine(line);
        
        expect(result).toEqual(safeFields);
      })
    );
  });
});
