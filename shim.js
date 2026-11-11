globalThis.global = globalThis;
export default new Proxy({}, { get: (target, key) => (typeof key === "string" && key !== "then" ? () => "" : undefined) });
export const Socket = class {};
