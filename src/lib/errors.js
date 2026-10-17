'use strict';

/** Помилка з HTTP-статусом і безпечним для клієнта текстом. */
class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'ERROR';
  }
}

module.exports = { ApiError };
