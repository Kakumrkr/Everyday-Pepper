import { ForbiddenError, LastOwnerError, MemberNotFoundError } from '@floty/core';
import { BusinessLimitReachedError, TenantSlugTakenError } from '@floty/db';
import { BadRequestException, HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { answering, toHttpError } from './domain-errors.js';

describe('toHttpError', () => {
  it.each([
    [new ForbiddenError('members.manage'), 403, 'forbidden'],
    [new MemberNotFoundError(), 404, 'member_not_found'],
    [new LastOwnerError(), 409, 'last_owner'],
    [new BusinessLimitReachedError(5), 409, 'business_limit_reached'],
    [new TenantSlugTakenError(), 409, 'slug_taken'],
  ])('%s → %d %s', (error, status, code) => {
    const answer = toHttpError(error);
    expect(answer).toBeInstanceOf(HttpException);
    expect((answer as HttpException).getStatus()).toBe(status);
    expect((answer as HttpException).getResponse()).toMatchObject({ code });
  });

  it('passes HTTP errors and unexpected errors through unchanged', () => {
    const http = new BadRequestException();
    const unexpected = new Error('boom');
    expect(toHttpError(http)).toBe(http);
    expect(toHttpError(unexpected)).toBe(unexpected);
  });
});

describe('answering', () => {
  it('returns the result or throws the mapped error', async () => {
    await expect(answering(() => Promise.resolve(1))).resolves.toBe(1);
    await expect(answering(() => Promise.reject(new LastOwnerError()))).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});
