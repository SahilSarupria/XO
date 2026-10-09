export const noopAuditSink = {
    record() {
        /* discards every event */
    },
};
/** An in-memory sink for tests/inspection — not a production logging solution. */
export class InMemoryAuditSink {
    events = [];
    record(event) {
        this.events.push(event);
    }
    all() {
        return this.events;
    }
    ofType(type) {
        return this.events.filter((e) => e.type === type);
    }
}
//# sourceMappingURL=audit.js.map