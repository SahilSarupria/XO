export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('/'))) {
      const tsSpecifier = specifier.slice(0, -3) + '.ts';
      return nextResolve(tsSpecifier, context);
    }
    throw error;
  }
}
