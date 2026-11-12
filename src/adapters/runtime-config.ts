import { readFile } from "node:fs/promises";
import { parseRuntimeFile } from "../config.js";
import type { RuntimeSettings } from "../config.js";
import type { HistoryRules, HistoryRulesSource, Logger } from "../usecases/ports.js";

/** The current runtime settings; the history use case reads its rules from it on every request. */
export class RuntimeSettingsHolder implements HistoryRulesSource {
  private settings: RuntimeSettings;

  constructor(startup: RuntimeSettings) {
    this.settings = { logLevel: startup.logLevel, historyRules: { ...startup.historyRules } };
  }

  current(): HistoryRules {
    return this.settings.historyRules;
  }

  get(): RuntimeSettings {
    return this.settings;
  }

  set(settings: RuntimeSettings): void {
    this.settings = { logLevel: settings.logLevel, historyRules: { ...settings.historyRules } };
  }
}

export interface RuntimeConfigWatcherOptions {
  /** RUNTIME_CONFIG_FILE: a file of the ConfigMap mounted as a directory (a subPath mount never updates). */
  file: string;
  pollMs: number;
  /** The values from defaults and environment; a key missing from the file falls back to them. */
  startup: RuntimeSettings;
  /** Runtime keys the environment sets: they keep their environment value (ADR-037), whatever the file says. */
  setInEnv?: readonly string[];
  /**
   * The settings in force now: a key with an invalid value in the file keeps this value, so a typo never undoes an
   * override that is running. Without it an invalid key falls back to `startup`.
   */
  current?: () => RuntimeSettings;
  logger: Logger;
  /** Called with the new settings each time the file's content changes, and once at start when the file exists. */
  onChange: (settings: RuntimeSettings) => void;
}

/**
 * Watches the runtime configuration file (ADR-037). A ConfigMap update reaches the pod by a link swap of the mounted
 * directory, which file events report unreliably, so the file is simply read every `pollMs` and compared with the
 * last content. A missing or unreadable file keeps the settings as they are and is logged once until it is back.
 */
export class RuntimeConfigWatcher {
  private lastContent: string | null = null;
  private missingLogged = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RuntimeConfigWatcherOptions) {}

  /** Reads the file once; true when its content changed and onChange was called. */
  async checkNow(): Promise<boolean> {
    const { file, startup, logger, onChange } = this.options;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      if (!this.missingLogged) logger.warn({ file, err: error }, "The runtime configuration file cannot be read; keeping the current settings");
      this.missingLogged = true;
      return false;
    }
    this.missingLogged = false;
    if (content === this.lastContent) return false;
    this.lastContent = content;
    const { settings, problems } = parseRuntimeFile(content, startup, this.options.setInEnv, this.options.current?.() ?? startup);
    for (const problem of problems) logger.warn({ file, problem }, "Ignored a setting of the runtime configuration file");
    onChange(settings);
    logger.info({ file, logLevel: settings.logLevel, historyRules: settings.historyRules }, "Applied the runtime configuration");
    return true;
  }

  /** Reads the file now and then every pollMs until stop(). */
  async start(): Promise<void> {
    await this.checkNow();
    this.timer = setInterval(() => {
      void this.checkNow();
    }, this.options.pollMs);
    this.timer.unref();
  }

  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return Promise.resolve();
  }
}
