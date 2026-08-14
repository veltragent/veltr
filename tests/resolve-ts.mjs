import { registerHooks } from "node:module";

/**
 * Lets the test runner import the app's TypeScript directly.
 *
 * Node strips types natively, but its ESM resolver still demands a file
 * extension, while the application's imports are extensionless because that is
 * what the Next.js bundler expects. Rather than change every import in the app to
 * suit the tests, resolution falls back to the `.ts` file — which is what the
 * bundler does too.
 *
 * The alternative was a transpiler and a test framework as dependencies, for a
 * project that currently has four.
 */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s(x|on)?$/.test(specifier)) {
      try {
        return next(specifier, context);
      } catch {
        try {
          return next(`${specifier}.ts`, context);
        } catch {
          return next(`${specifier}/index.ts`, context);
        }
      }
    }
    return next(specifier, context);
  },
});
