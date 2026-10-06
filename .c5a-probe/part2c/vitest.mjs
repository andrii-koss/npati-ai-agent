/**
 * Minimal `vitest` shim for the local harness (verification aid, not a deliverable).
 *
 * The sandbox cannot start vitest (esbuild's service binary is blocked: `spawn EPERM`), so the real test
 * files are executed through this module instead: it implements exactly the matchers the C5a suites use
 * (`toBe`, `toEqual`, `toMatchObject`, `toHaveLength`, `toContain`, `toBeTruthy`, `toBeInstanceOf`,
 * `toThrowError`, `not`, `resolves`, `rejects`, `expect.arrayContaining`, `vi.fn`). The spec files
 * themselves are untouched — this is a test *runner*, not a rewrite of the assertions.
 */
const registry = { tests: [] };
const stack = [];

export function describe(name, fn) {
  stack.push(String(name));
  try {
    fn();
  } finally {
    stack.pop();
  }
}

export function it(name, fn) {
  registry.tests.push({ name: [...stack, String(name)].join(" > "), fn });
}

export const test = it;
/** `it.each(cases)(name, fn)` — the printf placeholders are substituted like vitest does. */
it.each = (cases) => (name, fn) => {
  for (const entry of cases) {
    const args = Array.isArray(entry) ? [...entry] : [entry];
    let cursor = 0;
    const label = String(name).replace(/%[sdifjo%]/g, (token) => (token === "%%" ? "%" : format(args[cursor++])));
    it(label, () => fn(...args));
  }
};
export const beforeEach = () => {};
export const afterEach = () => {};
export const beforeAll = () => {};
export const afterAll = () => {};

export function __reset() {
  registry.tests.length = 0;
  stack.length = 0;
}

export function __registry() {
  return registry.tests;
}

class AssertionError extends Error {}

function format(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp) &&
    !(value instanceof Map) &&
    !(value instanceof Set)
  );
}

/** Deep equality with vitest's `undefined`-insensitive object semantics. */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue;
      out[key] = normalize(value[key]);
    }
    return out;
  }
  return value;
}

function deepEqual(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
  }
  return Object.is(left, right);
}

/** `toMatchObject` semantics: the actual value may carry more, the expected shape must be contained. */
function subsetMatch(actual, expected) {
  if (isPlainObject(expected) && expected.__arrayContaining) {
    if (!Array.isArray(actual)) return false;
    return expected.__arrayContaining.every((item) => actual.some((entry) => subsetMatch(entry, item)));
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((entry, index) => subsetMatch(actual[index], entry));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.keys(expected).every((key) => subsetMatch(actual[key], expected[key]));
  }
  return Object.is(actual, expected);
}

function syncMatchers(actual, negated) {
  const assert = (passed, message) => {
    const failed = negated ? passed : !passed;
    if (failed) throw new AssertionError(negated ? `not(${message})` : message);
  };
  return {
    toBe(expected) {
      assert(Object.is(actual, expected), `expected ${format(actual)} to be ${format(expected)}`);
    },
    toEqual(expected) {
      assert(deepEqual(actual, expected), `expected ${format(actual)} to equal ${format(expected)}`);
    },
    toMatchObject(expected) {
      assert(subsetMatch(actual, expected), `expected ${format(actual)} to match ${format(expected)}`);
    },
    toHaveLength(expected) {
      assert(actual != null && actual.length === expected, `expected length ${actual?.length} to be ${expected}`);
    },
    toMatch(expected) {
      assert(expected instanceof RegExp && expected.test(String(actual)), `expected ${format(actual)} to match ${String(expected)}`);
    },
    toContain(expected) {
      const passed = typeof actual === "string" ? actual.includes(expected) : Array.isArray(actual) && actual.some((entry) => deepEqual(entry, expected));
      assert(passed, `expected ${format(actual)} to contain ${format(expected)}`);
    },
    toBeTruthy() {
      assert(Boolean(actual), `expected ${format(actual)} to be truthy`);
    },
    toHaveProperty(path, value) {
      const has = actual != null && Object.prototype.hasOwnProperty.call(Object(actual), String(path));
      assert(
        has && (arguments.length < 2 || deepEqual(actual[path], value)),
        `expected ${format(actual)} to have property ${String(path)}${arguments.length < 2 ? "" : ` = ${format(value)}`}`,
      );
    },
    toBeUndefined() {
      assert(actual === undefined, `expected ${format(actual)} to be undefined`);
    },
    toBeDefined() {
      assert(actual !== undefined, "expected the value to be defined");
    },
    toBeNull() {
      assert(actual === null, `expected ${format(actual)} to be null`);
    },
    toBeFalsy() {
      assert(!actual, `expected ${format(actual)} to be falsy`);
    },
    toBeGreaterThan(expected) {
      assert(actual > expected, `expected ${format(actual)} to be greater than ${format(expected)}`);
    },
    toBeGreaterThanOrEqual(expected) {
      assert(actual >= expected, `expected ${format(actual)} to be >= ${format(expected)}`);
    },
    toBeLessThan(expected) {
      assert(actual < expected, `expected ${format(actual)} to be less than ${format(expected)}`);
    },
    toBeLessThanOrEqual(expected) {
      assert(actual <= expected, `expected ${format(actual)} to be <= ${format(expected)}`);
    },
    toContainEqual(expected) {
      assert(Array.isArray(actual) && actual.some((entry) => deepEqual(entry, expected)), `expected ${format(actual)} to contain ${format(expected)}`);
    },
    toHaveBeenCalled() {
      assert(Array.isArray(actual?.mock?.calls) && actual.mock.calls.length > 0, "expected the mock to have been called");
    },
    toHaveBeenCalledTimes(expected) {
      assert(actual?.mock?.calls?.length === expected, `expected the mock to have been called ${expected} times (was ${actual?.mock?.calls?.length ?? 0})`);
    },
    toHaveBeenCalledWith(...expected) {
      assert(Array.isArray(actual?.mock?.calls) && actual.mock.calls.some((call) => deepEqual(call, expected)), `expected the mock to have been called with ${format(expected)}`);
    },
    toHaveBeenLastCalledWith(...expected) {
      const calls = actual?.mock?.calls ?? [];
      assert(calls.length > 0 && deepEqual(calls[calls.length - 1], expected), `expected the mock's last call to be ${format(expected)}`);
    },
    toThrow(expected) {
      let thrown = null;
      try {
        actual();
      } catch (error) {
        thrown = error;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      const matches =
        thrown !== null &&
        (expected === undefined ||
          (expected instanceof RegExp ? expected.test(message) : expected instanceof Error ? thrown instanceof expected.constructor : message.includes(String(expected))));
      assert(matches, `expected the call to throw${expected === undefined ? "" : ` ${format(String(expected))}`} (threw: ${message})`);
    },
    toBeInstanceOf(expected) {
      assert(actual instanceof expected, `expected ${format(actual)} to be an instance of ${expected?.name}`);
    },
    toThrowError(expected) {
      let thrown = null;
      try {
        actual();
      } catch (error) {
        thrown = error;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      const matches = thrown !== null && (expected instanceof RegExp ? expected.test(message) : message.includes(String(expected ?? "")));
      assert(matches, `expected the call to throw ${format(String(expected ?? ""))} (threw: ${message})`);
    },
    get resolves() {
      return asyncMatchers(actual, negated, "resolve");
    },
    get rejects() {
      return asyncMatchers(actual, negated, "reject");
    },
  };
}

function asyncMatchers(promise, negated, mode) {
  const withValue = async (apply) => {
    let settled;
    try {
      const value = await promise;
      settled = { matched: mode === "resolve", value };
    } catch (error) {
      settled = { matched: mode === "reject", value: error };
    }
    const failed = negated ? settled.matched : !settled.matched;
    if (failed) {
      throw new AssertionError(
        mode === "resolve"
          ? `expected the promise to resolve, but it rejected with ${format(settled.value)}`
          : `expected the promise to reject, but it resolved with ${format(settled.value)}`,
      );
    }
    return apply(settled.value);
  };
  return new Proxy(
    {},
    {
      get: (_target, property) => (...args) => withValue((value) => syncMatchers(value, negated)[property](...args)),
    },
  );
}

function expectFactory(actual) {
  const base = syncMatchers(actual, false);
  return {
    ...base,
    not: syncMatchers(actual, true),
    resolves: asyncMatchers(actual, false, "resolve"),
    rejects: asyncMatchers(actual, false, "reject"),
  };
}

expectFactory.arrayContaining = (items) => ({ __arrayContaining: [...items] });

export const expect = expectFactory;

export const vi = {
  fn(implementation) {
    const calls = [];
    const wrapper = (...args) => {
      calls.push(args);
      return implementation ? implementation(...args) : undefined;
    };
    wrapper.mock = { calls, results: [] };
    return wrapper;
  },
};
