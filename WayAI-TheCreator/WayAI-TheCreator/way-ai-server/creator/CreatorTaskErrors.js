"use strict";

// Idempotency-edge-case vocabulary for video/audio jobs that submit to a remote
// provider and are later resumed (polled) rather than resubmitted after a
// server restart — codifies the specific ways a resume attempt can legitimately
// fail, so callers can react correctly (retry vs. resubmit vs. give up) instead
// of treating every failure the same way.

class ResumeExpiredError extends Error {
  constructor(message = "The provider job has expired and can no longer be resumed.") {
    super(message);
    this.name = "ResumeExpiredError";
  }
}

class ResumeEndpointChangedError extends Error {
  constructor(message = "The provider endpoint changed since this job was submitted; it cannot be resumed from here.") {
    super(message);
    this.name = "ResumeEndpointChangedError";
  }
}

class AmbiguousSubmitError extends Error {
  constructor(message = "Cannot tell whether the original submission reached the provider; refusing to resubmit and risk a duplicate paid job.") {
    super(message);
    this.name = "AmbiguousSubmitError";
  }
}

module.exports = { ResumeExpiredError, ResumeEndpointChangedError, AmbiguousSubmitError };
