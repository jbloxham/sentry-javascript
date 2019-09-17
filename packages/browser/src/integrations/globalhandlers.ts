import { getCurrentHub } from '@sentry/core';
import { Event, Integration, Severity } from '@sentry/types';
import {
  addExceptionTypeValue,
  isPrimitive,
  isString,
  keysToEventMessage,
  logger,
  normalize,
  normalizeToSize,
  truncate,
} from '@sentry/utils';

import { shouldIgnoreOnError } from '../helpers';
import { eventFromStacktrace } from '../parsers';
import { StackTrace as TraceKitStackTrace, _computeStackTrace } from '../tracekit';

import { getGlobalObject, getLocationHref, isError, isErrorEvent } from '@sentry/utils';

/** JSDoc */
interface GlobalHandlersIntegrations {
  onerror: boolean;
  onunhandledrejection: boolean;
}

/** Global handlers */
export class GlobalHandlers implements Integration {
  /**
   * @inheritDoc
   */
  public name: string = GlobalHandlers.id;

  /**
   * @inheritDoc
   */
  public static id: string = 'GlobalHandlers';

  /** JSDoc */
  private readonly _options: GlobalHandlersIntegrations;

  /** JSDoc */
  private readonly _global: Window = getGlobalObject();

  /** JSDoc */
  private _oldOnErrorHandler: OnErrorEventHandler = null;

  /** JSDoc */
  private _oldOnUnhandledRejectionHandler: ((e: any) => void) | null = null;

  /** JSDoc */
  private _onErrorHandlerInstalled: boolean = false;

  /** JSDoc */
  private _onUnhandledRejectionHandlerInstalled: boolean = false;

  /** JSDoc */
  public constructor(options?: GlobalHandlersIntegrations) {
    this._options = {
      onerror: true,
      onunhandledrejection: true,
      ...options,
    };
  }
  /**
   * @inheritDoc
   */
  public setupOnce(): void {
    Error.stackTraceLimit = 50;

    if (this._options.onerror) {
      logger.log('Global Handler attached: onerror');
      this._installGlobalOnErrorHandler();
    }

    if (this._options.onunhandledrejection) {
      logger.log('Global Handler attached: onunhandledrejection');
      this._installGlobalOnUnhandledRejectionHandler();
    }
  }

  /** JSDoc */
  private _installGlobalOnErrorHandler(): void {
    if (this._onErrorHandlerInstalled) {
      return;
    }

    const self = this; // tslint:disable-line:no-this-assignment
    const UNKNOWN_FUNCTION = '?';
    const ERROR_TYPES_RE = /^(?:[Uu]ncaught (?:exception: )?)?(?:((?:Eval|Internal|Range|Reference|Syntax|Type|URI|)Error): )?(.*)$/;

    this._oldOnErrorHandler = this._global.onerror;

    this._global.onerror = function(msg: any, url: any, line: any, column: any, e: any): boolean {
      const hasIntegration = getCurrentHub().getIntegration(GlobalHandlers);

      if (!hasIntegration) {
        if (self._oldOnErrorHandler) {
          return self._oldOnErrorHandler.apply(this, arguments);
        }
        return false;
      }

      // If 'e' is ErrorEvent, get real Error from inside
      const error = isErrorEvent(e) ? e.error : e;
      // If 'message' is ErrorEvent, get real message from inside
      let message = isErrorEvent(msg) ? msg.message : msg;
      let stack: TraceKitStackTrace;

      if (error && isError(error)) {
        stack = _computeStackTrace(error);
        stack.mechanism = 'onerror';
      } else {
        let name;

        if (isString(message)) {
          const groups = message.match(ERROR_TYPES_RE);
          if (groups) {
            name = groups[1];
            message = groups[2];
          }
        }

        stack = {
          mechanism: 'onerror',
          message,
          mode: 'onerror',
          name,
          stack: [
            {
              args: [],
              column,
              func: UNKNOWN_FUNCTION,
              line,
              url: url || getLocationHref(),
            },
          ],
        };
      }

      const isFailedOwnDelivery = error && error.__sentry_own_request__ === true;
      if (!shouldIgnoreOnError() && !isFailedOwnDelivery) {
        getCurrentHub().captureEvent(self._eventFromGlobalHandler(stack, 'onerror', error), {
          data: { stack },
          originalException: error,
        });
      }

      if (self._oldOnErrorHandler) {
        return self._oldOnErrorHandler.apply(this, arguments);
      }

      return false;
    };

    this._onErrorHandlerInstalled = true;
  }

  /** JSDoc */
  private _installGlobalOnUnhandledRejectionHandler(): void {
    if (this._onUnhandledRejectionHandlerInstalled) {
      return;
    }

    const self = this; // tslint:disable-line:no-this-assignment
    this._oldOnUnhandledRejectionHandler = this._global.onunhandledrejection;

    this._global.onunhandledrejection = function(e: any): void {
      const hasIntegration = getCurrentHub().getIntegration(GlobalHandlers);

      if (!hasIntegration) {
        return;
      }

      let error = e;
      try {
        error = e && 'reason' in e ? e.reason : e;
      } catch (_oO) {}

      const isFailedOwnDelivery = error && error.__sentry_own_request__ === true;
      if (shouldIgnoreOnError() || isFailedOwnDelivery) {
        return;
      }

      const stack = _computeStackTrace(error);
      stack.mechanism = 'onunhandledrejection';

      getCurrentHub().captureEvent(self._eventFromGlobalHandler(stack, 'onunhandledrejection', error), {
        data: { stack },
        originalException: error,
      });

      if (self._oldOnUnhandledRejectionHandler) {
        self._oldOnUnhandledRejectionHandler.apply(this, arguments);
      }
    };

    this._onUnhandledRejectionHandlerInstalled = true;
  }

  /**
   * This function creates an Event from an TraceKitStackTrace.
   *
   * @param stacktrace TraceKitStackTrace to be converted to an Event.
   */
  private _eventFromGlobalHandler(stacktrace: TraceKitStackTrace, handler: string, error: any): Event {
    if (!isString(stacktrace.message) && stacktrace.mechanism !== 'onunhandledrejection') {
      // There are cases where stacktrace.message is an Event object
      // https://github.com/getsentry/sentry-javascript/issues/1949
      // In this specific case we try to extract stacktrace.message.error.message
      const message = (stacktrace.message as unknown) as any;
      stacktrace.message =
        message.error && isString(message.error.message) ? message.error.message : 'No error message';
    }

    if (handler === 'onunhandledrejection' && stacktrace.mode === 'failed') {
      return this._eventFromIncompleteRejection(stacktrace, handler, error);
    }

    const event = eventFromStacktrace(stacktrace);

    const data: { [key: string]: string } = {
      mode: stacktrace.mode,
    };

    if (stacktrace.message) {
      data.message = stacktrace.message;
    }

    if (stacktrace.name) {
      data.name = stacktrace.name;
    }

    const client = getCurrentHub().getClient();
    const maxValueLength = (client && client.getOptions().maxValueLength) || 250;

    const fallbackValue = stacktrace.original
      ? truncate(JSON.stringify(normalize(stacktrace.original)), maxValueLength)
      : '';
    const fallbackType = handler === 'onunhandledrejection' ? 'UnhandledRejection' : 'Error';

    // This makes sure we have type/value in every exception
    addExceptionTypeValue(event, fallbackValue, fallbackType, {
      data,
      handled: false,
      type: handler,
    });

    return event;
  }

  /**
   * This function creates an Event from an TraceKitStackTrace that has part of it missing.
   *
   * @param stacktrace TraceKitStackTrace to be converted to an Event.
   */
  private _eventFromIncompleteRejection(stacktrace: TraceKitStackTrace, handler: string, error: any): Event {
    const event: Event = {
      level: Severity.Error,
    };

    if (isPrimitive(error)) {
      event.exception = {
        values: [
          {
            type: 'UnhandledRejection',
            value: `Non-Error promise rejection captured with value: ${error}`,
          },
        ],
      };
    } else {
      event.exception = {
        values: [
          {
            type: 'UnhandledRejection',
            value: `Non-Error promise rejection captured with keys: ${keysToEventMessage(Object.keys(error).sort())}`,
          },
        ],
      };
      event.extra = {
        __serialized__: normalizeToSize(error),
      };
    }

    if (event.exception.values && event.exception.values[0]) {
      event.exception.values[0].mechanism = {
        data: {
          mode: stacktrace.mode,
          ...(stacktrace.message && { message: stacktrace.message }),
          ...(stacktrace.name && { name: stacktrace.name }),
        },
        handled: false,
        type: handler,
      };
    }

    return event;
  }
}
