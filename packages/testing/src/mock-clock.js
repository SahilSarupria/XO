export class SystemClock {
    now() {
        return new Date();
    }
}
export class MockClock {
    current;
    constructor(initial = '2026-01-01T00:00:00.000Z') {
        this.current = typeof initial === 'string' ? new Date(initial) : initial;
    }
    now() {
        return this.current;
    }
    advance(ms) {
        this.current = new Date(this.current.getTime() + ms);
    }
    set(date) {
        this.current = typeof date === 'string' ? new Date(date) : date;
    }
}
//# sourceMappingURL=mock-clock.js.map