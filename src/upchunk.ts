import { EventTarget } from 'event-target-shim';
import xhr, { XhrUrlConfig, XhrHeaders, XhrResponse } from 'xhr';

const SUCCESSFUL_CHUNK_UPLOAD_CODES = [200, 201, 202, 204, 308];
const TEMPORARY_ERROR_CODES = [408, 502, 503, 504]; // These error codes imply a chunk may be retried

type EventName =
  | 'data'
  | 'attempt'
  | 'attemptFailure'
  | 'error'
  | 'offline'
  | 'online'
  | 'progress'
  | 'success';

export interface IOptions {
  endpoint: string | (() => Promise<string>);
  headers?: XhrHeaders;
  maxChunkSize?: number;
  attempts?: number;
  delayBeforeAttempt?: number;
}

const MIN_CHUNK_SIZE = 256 * 1024

export class UpChunk {
  public endpoint: string | ((file?: File) => Promise<string>);
  public headers: XhrHeaders;
  public maxChunkSize: number;
  public attempts: number;
  public delayBeforeAttempt: number;

  private chunk: Blob;
  private chunkCount: number;
  private maxChunkByteSize: number;
  private endpointValue: string;
  private attemptCount: number;
  private offline: boolean;
  private paused: boolean;

  private eventTarget: EventTarget;

  private blob: Blob
  private allChunksReceived = false
  private lastIndex = 0

  constructor(options: IOptions) {
    this.endpoint = options.endpoint;
    this.headers = options.headers || ({} as XhrHeaders);
    this.maxChunkSize = options.maxChunkSize || 5120;
    this.attempts = options.attempts || 5;
    this.delayBeforeAttempt = options.delayBeforeAttempt || 1;

    this.chunkCount = 0;
    this.maxChunkByteSize = this.maxChunkSize * 1024;
    this.attemptCount = 0;
    this.offline = false;
    this.paused = false;

    this.eventTarget = new EventTarget();

    this.validateOptions();
    this.getEndpoint().then(() => this.sendChunks());

    // restart sync when back online
    // trigger events when offline/back online
    if (typeof(window) !== 'undefined') {
      window.addEventListener('online', () => {
        if (!this.offline) {
          return;
        }

        this.offline = false;
        this.dispatch('online');
        this.sendChunks();
      });

      window.addEventListener('offline', () => {
        this.offline = true;
        this.dispatch('offline');
      });
    }
  }

  public addChunk(chunk: Blob) {
    if (this.blob) {
      this.blob = new Blob([this.blob, chunk])
    } else {
      this.blob = new Blob([chunk])
    }
  }

  public finish() {
    this.allChunksReceived = true
  }

  /**
   * Subscribe to an event
   */
  public on(eventName: EventName, fn: (event: CustomEvent) => void) {
    this.eventTarget.addEventListener(eventName, fn);
  }

  public pause() {
    this.paused = true;
  }

  public resume() {
    if (this.paused) {
      this.paused = false;

      this.sendChunks();
    }
  }

  /**
   * Dispatch an event
   */
  private dispatch(eventName: EventName, detail?: any) {
    const event = new CustomEvent(eventName, { detail });

    this.eventTarget.dispatchEvent(event);
  }

  /**
   * Validate options and throw error if not of the right type
   */
  private validateOptions() {
    if (
      !this.endpoint ||
      (typeof this.endpoint !== 'function' && typeof this.endpoint !== 'string')
    ) {
      throw new TypeError(
        'endpoint must be defined as a string or a function that returns a promise'
      );
    }
    if (this.headers && typeof this.headers !== 'object') {
      throw new TypeError('headers must be null or an object');
    }
    if (
      this.maxChunkSize &&
      (typeof this.maxChunkSize !== 'number' ||
        this.maxChunkSize <= 0 ||
        this.maxChunkSize % 256 !== 0)
    ) {
      throw new TypeError(
        'chunkSize must be a positive number in multiples of 256'
      );
    }
    if (
      this.attempts &&
      (typeof this.attempts !== 'number' || this.attempts <= 0)
    ) {
      throw new TypeError('retries must be a positive number');
    }
    if (
      this.delayBeforeAttempt &&
      (typeof this.delayBeforeAttempt !== 'number' ||
        this.delayBeforeAttempt < 0)
    ) {
      throw new TypeError('delayBeforeAttempt must be a positive number');
    }
  }

  /**
   * Endpoint can either be a URL or a function that returns a promise that resolves to a string.
   */
  private getEndpoint() {
    if (typeof this.endpoint === 'string') {
      this.endpointValue = this.endpoint;
      return Promise.resolve(this.endpoint);
    }

    return this.endpoint().then((value) => {
      this.endpointValue = value;
      return this.endpointValue;
    });
  }

  /**
   * Get portion of the file of x bytes corresponding to chunkSize
   */
  private getChunk() {
    const nearestMultiple = (size: number) => MIN_CHUNK_SIZE * Math.floor(size / MIN_CHUNK_SIZE)
    return new Promise((resolve) => {
      const checkAndResolve = () => {
        if (!this.blob) {
          return setTimeout(checkAndResolve, 1000)
        }
        const remainingSize = this.blob.size - this.lastIndex
        if (this.allChunksReceived && remainingSize < MIN_CHUNK_SIZE) {
          this.chunk = this.blob.slice(this.lastIndex, this.lastIndex + remainingSize)
          resolve()
        } else if (remainingSize >= MIN_CHUNK_SIZE) {
          const size = remainingSize >= this.maxChunkByteSize ? this.maxChunkByteSize : nearestMultiple(remainingSize)
          this.chunk = this.blob.slice(this.lastIndex, this.lastIndex + size)
          resolve()
        } else {
          setTimeout(checkAndResolve, 1000)
        }
      }
      setTimeout(checkAndResolve, 1000)
    });
  }

  private xhrPromise(options: XhrUrlConfig): Promise<XhrResponse> {
    const beforeSend = (xhrObject: XMLHttpRequest) => {
      xhrObject.upload.onprogress = (event: ProgressEvent) => {
        const progress = ((this.lastIndex + event.loaded) / this.blob.size) * 100
        this.dispatch('progress', progress);
      };
    };

    return new Promise((resolve, reject) => {
      xhr({ ...options, beforeSend }, (err, resp) => {
        if (err) {
          return reject(err);
        }

        return resolve(resp);
      });
    });
  }

  /**
   * Send chunk of the file with appropriate headers and add post parameters if it's last chunk
   */
  private sendChunk() {
    const rangeStart = this.lastIndex;
    const rangeEnd = rangeStart + this.chunk.size - 1;
    const fileSize = this.allChunksReceived ? this.blob.size : '*'
    const headers = {
      ...this.headers,
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${fileSize}`,
    };

    this.dispatch('attempt', {
      chunkNumber: this.chunkCount,
      chunkSize: this.chunk.size/1024,
    });

    return this.xhrPromise({
      headers,
      url: this.endpointValue,
      method: 'PUT',
      body: this.chunk,
    });
  }

  /**
   * Called on net failure. If retry counter !== 0, retry after delayBeforeAttempt
   */
  private manageRetries() {
    if (this.attemptCount < this.attempts) {
      this.attemptCount = this.attemptCount + 1;
      setTimeout(() => this.sendChunks(), this.delayBeforeAttempt * 1000);
      this.dispatch('attemptFailure', {
        message: `An error occured uploading chunk ${this.chunkCount}. ${
          this.attempts - this.attemptCount
        } retries left.`,
        chunkNumber: this.chunkCount,
        attemptsLeft: this.attempts - this.attemptCount,
      });
      return;
    }

    this.dispatch('error', {
      message: `An error occured uploading chunk ${this.chunkCount}. No more retries, stopping upload`,
      chunk: this.chunkCount,
      attempts: this.attemptCount,
    });
  }

  /**
   * Manage the whole upload by calling getChunk & sendChunk
   * handle errors & retries and dispatch events
   */
  private sendChunks() {
    if (this.paused || this.offline) {
      return;
    }

    this.getChunk()
      .then(() => this.sendChunk())
      .then((res) => {
        if (SUCCESSFUL_CHUNK_UPLOAD_CODES.includes(res.statusCode)) {
          this.chunkCount = this.chunkCount + 1;
          this.lastIndex += this.chunk.size
          if (this.allChunksReceived && this.lastIndex >= this.blob.size) {
            this.dispatch('success');
          } else {
            this.sendChunks();
          }

          const percentProgress = Math.round(this.lastIndex / this.blob.size) * 100

          this.dispatch('progress', percentProgress);
        } else if (TEMPORARY_ERROR_CODES.includes(res.statusCode)) {
          if (this.paused || this.offline) {
            return;
          }
          this.manageRetries();
        } else {
          if (this.paused || this.offline) {
            return;
          }

          this.dispatch('error', {
            message: `Server responded with ${res.statusCode}. Stopping upload.`,
            chunkNumber: this.chunkCount,
            attempts: this.attemptCount,
          });
        }
      })
      .catch((err) => {
        if (this.paused || this.offline) {
          return;
        }

        // this type of error can happen after network disconnection on CORS setup
        this.manageRetries();
      });
  }
}

export const createUpload = (options: IOptions) => new UpChunk(options);
