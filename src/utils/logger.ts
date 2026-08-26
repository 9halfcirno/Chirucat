function formatTime(date: Date = new Date()) {
    const pad = (n: number) => n.toString().padStart(2, "0");

    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());

    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());
    const second = pad(date.getSeconds());

    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export default class Logger {
    private name: String;

    constructor(name: String) {
        this.name = name;
    }

    log(...args: any[]): void {
        console.log(`[${this.name}][${formatTime()}][INFO]`, ...args);
    }

    error(...args: any[]): void {
        console.error(`[${this.name}][${formatTime()}][ERROR]`, ...args);
    }

    warn(...args: any[]): void {
        console.warn(`[${this.name}][${formatTime()}][WARN]`, ...args);
    }

    info(...args: any[]): void {
        console.info(`[${this.name}][${formatTime()}][INFO]`, ...args);
    }

    debug(...args: any[]): void {
        console.debug(`[${this.name}][${formatTime()}][DEBUG]`, ...args);
    }
}