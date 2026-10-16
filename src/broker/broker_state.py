"""GPULink B2B experimental broker state: NO workload execution or launch authority.

Only test-fixture-backed authority is supported. In particular, this does NOT
coordinate transactionally with a live GPULink control-plane lease authority.
"""
import fcntl
import json
import os
import re
import stat
import sqlite3
import time
from pathlib import Path

ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
VERSION = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')
SHA = re.compile(r'^[a-f0-9]{64}$')
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
CONTROLS = frozenset(('process', 'filesystem', 'network', 'identity', 'resource-limits', 'gpu-device'))

class Denied(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def deny(code):
    raise Denied(code)


def is_id(v):
    return type(v) is str and bool(ID.fullmatch(v))


def positive(v):
    return type(v) is int and 0 < v <= 2**53 - 1


def shape(o, keys):
    return type(o) is dict and set(o) == set(keys)


def artifact_ok(a):
    return (shape(a, ('adapterId', 'version', 'sha256')) and
            is_id(a['adapterId']) and type(a['version']) is str and bool(VERSION.fullmatch(a['version'])) and
            type(a['sha256']) is str and bool(SHA.fullmatch(a['sha256'])))


def parse_intent(intent):
    fields = ('schemaVersion','attemptId','sessionId','leaseId','leaseGeneration',
              'runtimeId','reservationId','artifact','requiredIpcVersion')
    if not shape(intent, fields) or type(intent['schemaVersion']) is not int or intent['schemaVersion'] != 1:
        deny('broker_invalid_intent')
    if not all(is_id(intent[k]) for k in ('attemptId','sessionId','leaseId','runtimeId','reservationId')):
        deny('broker_invalid_intent')
    if not (positive(intent['leaseGeneration']) and positive(intent['requiredIpcVersion']) and
            intent['requiredIpcVersion'] <= 255 and artifact_ok(intent['artifact'])):
        deny('broker_invalid_intent')
    return intent


def strict_json(s):
    def pairs(items):
        result = {}
        for k, v in items:
            if k in result:
                deny('broker_invalid_message')
            result[k] = v
        return result
    def reject_constant(_):
        deny('broker_invalid_message')
    try:
        return json.loads(s, object_pairs_hook=pairs, parse_constant=reject_constant)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        deny('broker_invalid_message')


class BrokerLedger:
    """Attempt ownership is durable; authority is operator/test fixture only.

    Every broker start quarantines previously reserved attempts. This is an
    intentional fail-closed policy until real running-workload reconciliation exists.
    """
    def __init__(self, db_path, fixture):
        path = Path(db_path)
        if path.is_symlink() or path.parent.is_symlink():
            deny('broker_unsafe_state_path')
        if not path.parent.is_dir() or path.parent.stat().st_uid != os.geteuid() or path.parent.stat().st_mode & 0o077:
            deny('broker_unsafe_state_directory')
        if path.exists() and (not path.is_file() or path.stat().st_mode & 0o077):
            deny('broker_unsafe_state_path')
        # Broker singleton per journal. This file lock survives client disconnects
        # and is kernel-released on process death, preventing competing brokers
        # from silently taking ownership of the same journal.
        lock_path = path.with_name(path.name + '.lock')
        if lock_path.is_symlink():
            deny('broker_unsafe_lock_path')
        self.lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        st = os.fstat(self.lock_fd)
        if st.st_uid != os.geteuid() or st.st_mode & 0o077 or not stat.S_ISREG(st.st_mode):
            os.close(self.lock_fd)
            deny('broker_unsafe_lock_path')
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self.lock_fd)
            deny('broker_ledger_owned')
        try:
            self.db = sqlite3.connect(str(path), timeout=3, isolation_level=None)
        except BaseException:
            os.close(self.lock_fd)
            raise
        self.db.execute('PRAGMA busy_timeout=3000')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS attempts ('
            'attempt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, lease_id TEXT NOT NULL, '
            'generation INTEGER NOT NULL, reservation_id TEXT NOT NULL UNIQUE, '
            'worker_id TEXT NOT NULL, state TEXT NOT NULL, created_ms INTEGER NOT NULL)')
        os.chmod(path, 0o600)
        self.fixture = self._validate_fixture(fixture)
        self.db.execute('BEGIN IMMEDIATE')
        try:
            self.db.execute("UPDATE attempts SET state='quarantined' WHERE state='reserved'")
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    @staticmethod
    def _validate_fixture(f):
        if not shape(f, ('principals','leases','reservations','approvals','runtimes')) or not all(
            type(f[k]) is list for k in f):
            deny('broker_invalid_fixture')
        for principal in f['principals']:
            if not shape(principal, ('uid','workerId','runtimeIds')) or not (
                type(principal['uid']) is int and principal['uid'] >= 0 and is_id(principal['workerId']) and
                type(principal['runtimeIds']) is list and principal['runtimeIds'] and
                len(set(principal['runtimeIds'])) == len(principal['runtimeIds']) and
                all(is_id(v) for v in principal['runtimeIds'])):
                deny('broker_invalid_fixture')
        if len(set(p['uid'] for p in f['principals'])) != len(f['principals']):
            deny('broker_invalid_fixture')
        return f

    def _principal(self, peer_uid):
        matches = [x for x in self.fixture['principals'] if x['uid'] == peer_uid]
        if len(matches) != 1:
            deny('broker_unauthorized_peer')
        return matches[0]

    def _check_authority(self, intent, principal, now):
        def unique_record(key, predicate):
            records = [x for x in self.fixture[key] if predicate(x)]
            if len(records) != 1:
                deny('broker_missing_authority')
            return records[0]
        if intent['runtimeId'] not in principal['runtimeIds']:
            deny('broker_unauthorized_peer')
        lease = unique_record('leases', lambda x: x.get('sessionId') == intent['sessionId'])
        if not (lease.get('leaseId') == intent['leaseId'] and lease.get('generation') == intent['leaseGeneration'] and
                lease.get('workerId') == principal['workerId'] and lease.get('status') == 'active' and
                type(lease.get('expiresAtMs')) is int and lease['expiresAtMs'] > now):
            deny('broker_stale_lease')
        reservation = unique_record('reservations', lambda x: x.get('reservationId') == intent['reservationId'])
        if not (reservation.get('attemptId') == intent['attemptId'] and reservation.get('leaseId') == intent['leaseId'] and
                reservation.get('status') == 'held' and type(reservation.get('expiresAtMs')) is int and
                reservation['expiresAtMs'] > now and type(reservation.get('deviceIds')) is list and
                0 < len(reservation['deviceIds']) <= 8 and all(is_id(v) for v in reservation['deviceIds']) and
                len(set(reservation['deviceIds'])) == len(reservation['deviceIds'])):
            deny('broker_reservation_mismatch')
        approval = unique_record('approvals', lambda x: type(x.get('artifact')) is dict and x['artifact'].get('adapterId') == intent['artifact']['adapterId'])
        if not (approval.get('artifact') == intent['artifact'] and approval.get('runtimeId') == intent['runtimeId'] and
                approval.get('trustClass') == 'operator-trusted' and type(approval.get('imageDigest')) is str and
                DIGEST.fullmatch(approval['imageDigest']) and is_id(approval.get('profileId')) and
                type(approval.get('requiredControls')) is list and set(approval['requiredControls']) == CONTROLS and
                len(approval['requiredControls']) == len(CONTROLS)):
            deny('broker_artifact_not_approved')
        runtime = unique_record('runtimes', lambda x: x.get('runtimeId') == intent['runtimeId'])
        if not (runtime.get('available') is True and type(runtime.get('supportedIpcVersions')) is list and
                intent['requiredIpcVersion'] in runtime['supportedIpcVersions'] and
                type(runtime.get('verifiedControls')) is list and
                CONTROLS <= set(runtime['verifiedControls'])):
            deny('broker_runtime_not_verified')
        # These are *synthetic fixture assertions*, never effective host isolation proof.

    def claim(self, peer_uid, intent):
        req = parse_intent(intent)
        principal = self._principal(peer_uid)
        self.db.execute('BEGIN IMMEDIATE')
        try:
            self._check_authority(req, principal, int(time.time()*1000))
            self.db.execute('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?)',
                (req['attemptId'],req['sessionId'],req['leaseId'],req['leaseGeneration'],
                 req['reservationId'],principal['workerId'],'reserved',int(time.time()*1000)))
            self.db.execute('COMMIT')
        except sqlite3.IntegrityError:
            self.db.execute('ROLLBACK')
            deny('broker_attempt_replay')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise
        return {'schemaVersion':1,'status':'reserved-test-only','canLaunch':False,
                'attemptId':req['attemptId'],'advisoryOnly':True}

    def inspect(self, peer_uid, attempt_id):
        if not is_id(attempt_id):
            deny('broker_invalid_message')
        principal = self._principal(peer_uid)
        row = self.db.execute('SELECT worker_id,state FROM attempts WHERE attempt_id=?', (attempt_id,)).fetchone()
        if row is None or row[0] != principal['workerId']:
            deny('broker_attempt_not_found')
        return {'schemaVersion':1,'attemptId':attempt_id,'state':row[1],'canLaunch':False}

    def cancel(self, peer_uid, attempt_id):
        if not is_id(attempt_id):
            deny('broker_invalid_message')
        principal = self._principal(peer_uid)
        self.db.execute('BEGIN IMMEDIATE')
        try:
            cur = self.db.execute("UPDATE attempts SET state='cancelled' WHERE attempt_id=? AND worker_id=? AND state='reserved'",
                                  (attempt_id, principal['workerId']))
            row = self.db.execute('SELECT state FROM attempts WHERE attempt_id=? AND worker_id=?',
                                  (attempt_id, principal['workerId'])).fetchone()
            if row is None:
                deny('broker_attempt_not_found')
            self.db.execute('COMMIT')
            return {'schemaVersion':1,'attemptId':attempt_id,'state':row[0],'canLaunch':False}
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def close(self):
        self.db.close()
        fcntl.flock(self.lock_fd, fcntl.LOCK_UN)
        os.close(self.lock_fd)
