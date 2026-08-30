// Small typed helpers for the tests.
//
// They exist mainly so the callback style of this adapter can be awaited without every
// `new Promise()` needing its own type hint - a declared return type gives TypeScript the
// Promise type parameter it needs for a `resolve()` without arguments.

/**
 * Resolves after the given time.
 *
 * @param {number} ms milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wraps a function that reports completion through a callback into a promise.
 *
 * @param {(done: () => void) => void} run receives the callback that resolves the promise
 * @returns {Promise<void>}
 */
function callbackPromise(run) {
    return new Promise(resolve => run(() => resolve()));
}

/**
 * Wraps a callback that reports an error as its first argument into a promise.
 *
 * @param {(done: (err?: unknown) => void) => void} run receives the node style callback
 * @returns {Promise<void>}
 */
function nodeCallbackPromise(run) {
    return new Promise((resolve, reject) =>
        run(err => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve())),
    );
}

/**
 * Collects every control of an admin jsonConfig, no matter how deeply it is nested in
 * tabs and panels. The root of the config is a tabs/panel tree, so a plain lookup on
 * `config.items` only finds the tabs themselves.
 *
 * @param {object} config parsed admin/jsonConfig.json
 * @returns {Record<string, any>} all items by their key, panels and tabs included
 */
function collectJsonConfigItems(config) {
    /** @type {Record<string, any>} */
    const all = {};
    const walk = node => {
        if (!node || typeof node !== 'object' || !node.items) {
            return;
        }
        Object.keys(node.items).forEach(key => {
            const item = node.items[key];
            all[key] = item;
            walk(item);
        });
    };
    walk(config);
    return all;
}

module.exports = { delay, callbackPromise, nodeCallbackPromise, collectJsonConfigItems };
