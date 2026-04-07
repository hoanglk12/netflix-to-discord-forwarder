import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasExactDuplicateWindow,
  selectLatestMatchingMessages,
  selectLatestMatchingMessagesForRun,
} from '../src/poller.js';

test('selects the latest five messages whose sender contains the configured domain', () => {
  const messages = [
    { id: '1', from: 'Netflix <a@mailer.netflix.com>', internalDate: 1 },
    { id: '2', from: 'Other <a@example.com>', internalDate: 2 },
    { id: '3', from: 'Netflix <b@mailer.netflix.com>', internalDate: 3 },
    { id: '4', from: 'Netflix <c@mailer.netflix.com>', internalDate: 4 },
    { id: '5', from: 'Netflix <d@mailer.netflix.com>', internalDate: 5 },
    { id: '6', from: 'Netflix <e@mailer.netflix.com>', internalDate: 6 },
    { id: '7', from: 'Netflix <f@mailer.netflix.com>', internalDate: 7 },
  ];

  const selected = selectLatestMatchingMessages(messages, {
    gmailSenderFilter: 'netflix.com',
    forwardLatestCount: 5,
  });

  assert.deepEqual(selected.map((message) => message.id), ['3', '4', '5', '6', '7']);
});

test('selects latest five messages as of run time in once mode', () => {
  const messages = [
    { id: '1', from: 'Netflix <a@mailer.netflix.com>', internalDate: 1 },
    { id: '2', from: 'Netflix <b@mailer.netflix.com>', internalDate: 2 },
    { id: '3', from: 'Netflix <c@mailer.netflix.com>', internalDate: 3 },
    { id: '4', from: 'Netflix <d@mailer.netflix.com>', internalDate: 4 },
    { id: '5', from: 'Netflix <e@mailer.netflix.com>', internalDate: 5 },
    { id: '6', from: 'Netflix <f@mailer.netflix.com>', internalDate: 6 },
    { id: '7', from: 'Netflix <g@mailer.netflix.com>', internalDate: 7 },
  ];

  const selected = selectLatestMatchingMessagesForRun(messages, {
    gmailSenderFilter: 'netflix.com',
    forwardLatestCount: 5,
  }, 6);

  assert.deepEqual(selected.map((message) => message.id), ['2', '3', '4', '5', '6']);
});

test('detects exact duplicate latest-five window', () => {
  const current = ['a', 'b', 'c', 'd', 'e'];
  const previous = ['a', 'b', 'c', 'd', 'e'];

  assert.equal(hasExactDuplicateWindow(current, previous, 5), true);
});

test('does not treat partial overlap as exact duplicate window', () => {
  const current = ['a', 'b', 'c', 'd', 'e'];
  const previous = ['a', 'b', 'x', 'd', 'e'];

  assert.equal(hasExactDuplicateWindow(current, previous, 5), false);
});