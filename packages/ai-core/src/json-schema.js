function validateAt(schema, value, path, issues) {
    switch (schema.type) {
        case 'object': {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                issues.push({ path, message: `expected an object, got ${describeType(value)}` });
                return;
            }
            const obj = value;
            for (const key of schema.required) {
                if (!(key in obj))
                    issues.push({ path: `${path}.${key}`, message: 'missing required property' });
            }
            for (const [key, propSchema] of Object.entries(schema.properties)) {
                if (key in obj)
                    validateAt(propSchema, obj[key], `${path}.${key}`, issues);
            }
            return;
        }
        case 'array': {
            if (!Array.isArray(value)) {
                issues.push({ path, message: `expected an array, got ${describeType(value)}` });
                return;
            }
            value.forEach((item, i) => validateAt(schema.items, item, `${path}[${i}]`, issues));
            return;
        }
        case 'string': {
            if (typeof value !== 'string') {
                issues.push({ path, message: `expected a string, got ${describeType(value)}` });
                return;
            }
            if (schema.enum && !schema.enum.includes(value)) {
                issues.push({ path, message: `expected one of [${schema.enum.join(', ')}], got "${value}"` });
            }
            return;
        }
        case 'number':
            if (typeof value !== 'number')
                issues.push({ path, message: `expected a number, got ${describeType(value)}` });
            return;
        case 'boolean':
            if (typeof value !== 'boolean')
                issues.push({ path, message: `expected a boolean, got ${describeType(value)}` });
            return;
    }
}
function describeType(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return 'array';
    return typeof value;
}
export function validateJsonSchema(schema, value) {
    const issues = [];
    validateAt(schema, value, '$', issues);
    return issues;
}
//# sourceMappingURL=json-schema.js.map