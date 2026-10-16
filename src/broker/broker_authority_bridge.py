"""B2C2B2C2: opt-in, NON-EXECUTING broker-to-control-plane reservation bridge.

This is a test-only authority transport, not production host attestation or workload
execution. The control plane is solely authoritative over GPU identity and leases.
Locally durable pending claims are never automatically retried or released: after
an ambiguous HTTP result the control plane may already hold the GPU fence.
"""
import http.client
import json
import os
import sqlite3
from pathlib import Path
import socket
import stat
import time
from urllib.parse import urlsplit

from broker_state import deny, is_id, shape, strict_json

MAX_REMOTE_BODY = 4096
OPERATION = 'reserve-authoritative'
OPERATION_OBSERVE = 'observe-authoritative'
FIELDS = ('subjectKind', 'subjectId', 'leaseId', 'attemptId')


def _read_operator_file(path, *, limit):
    if type(path) is not str or not path.startswith('/') or len(path) > 1024:
        deny('broker_unsafe_authority_config')
    p = Path(path)
    # O_NOFOLLOW prevents a leaf symlink. O_NONBLOCK prevents blocking on a FIFO.
    flags = os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    try:
        fd = os.open(p, flags)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
                deny('broker_unsafe_authority_config')
            if info.st_size < 1 or info.st_size > limit:
                deny('broker_unsafe_authority_config')
            raw = os.read(fd, limit + 1)
            if len(raw) != info.st_size:
                deny('broker_unsafe_authority_config')
            return raw
        finally:
            os.close(fd)
    except OSError:
        deny('broker_unsafe_authority_config')


def _load_config(path):
    try:
        doc = json.loads(_read_operator_file(path, limit=2048).decode('utf-8'))
    except (ValueError, UnicodeError):
        deny('broker_unsafe_authority_config')
    if not shape(doc, ('schemaVersion', 'workerId', 'baseUrl', 'tokenFile')) or type(doc['schemaVersion']) is not int or doc['schemaVersion'] != 1 or not is_id(doc['workerId']):
        deny('broker_unsafe_authority_config')
    if type(doc['baseUrl']) is not str or len(doc['baseUrl']) > 300:
        deny('broker_unsafe_authority_config')
    try:
        address = urlsplit(doc['baseUrl'])
        port = address.port
    except ValueError:
        deny('broker_unsafe_authority_config')
    if address.scheme not in ('http', 'https') or not address.hostname or not port or address.username or address.password or address.path or address.query or address.fragment:
        deny('broker_unsafe_authority_config')
    # Non-TLS broker credentials are permitted only for process-local loopback
    # acceptance tests. HTTPS uses default certificate/hostname verification.
    if address.scheme == 'http' and address.hostname not in ('127.0.0.1', '::1'):
        deny('broker_unsafe_authority_config')
    token = _read_operator_file(doc['tokenFile'], limit=512)
    if len(token) < 32 or len(token) > 512 or any(c < 0x21 or c > 0x7e for c in token) or b'\r' in token or b'\n' in token:
        deny('broker_unsafe_authority_config')
    return (doc['workerId'], address.scheme, address.hostname, port, token.decode('ascii'))


def _valid_request(req):
    if not shape(req, FIELDS) or req.get('subjectKind') not in ('job', 'session') or any(not is_id(req.get(k)) for k in FIELDS[1:]):
        deny('broker_invalid_message')
    return req


class BrokerAuthorityBridge:
    """Owns outgoing credential and monotonic local anti-replay/uncertainty journal.

    Only the existing broker's kernel-authenticated Unix peer can invoke this.
    Uses the already-singleton broker SQLite journal, never an independent GPU
    allocator or a local source of lease authority.
    """
    def __init__(self, ledger, operator_config_file):
        self.ledger = ledger
        self.worker_id, self.scheme, self.hostname, self.port, self.token = _load_config(operator_config_file)
        # Do not accept a credential scoped to a worker other than the kernel-UID
        # principal configured by the operator. The control plane independently
        # enforces both worker and project scope.
        if sum(1 for p in ledger.fixture['principals'] if p['workerId'] == self.worker_id) != 1:
            deny('broker_authority_worker_mismatch')
        ledger.db.execute('CREATE TABLE IF NOT EXISTS remote_claims ('
            'attempt_id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, '
            'lease_id TEXT NOT NULL, worker_id TEXT NOT NULL, status TEXT NOT NULL, '
            'fence_epoch INTEGER, created_ms INTEGER NOT NULL)')
        ledger.db.execute('BEGIN IMMEDIATE')
        try:
            # Restart is NOT proof that a previous request failed. Even a
            # previously acknowledged reservation requires reconciliation.
            ledger.db.execute("UPDATE remote_claims SET status='quarantined' WHERE status IN ('pending','reserved')")
            ledger.db.execute('COMMIT')
        except BaseException:
            ledger.db.execute('ROLLBACK')
            raise

    def reserve(self, kernel_peer_uid, request):
        req = _valid_request(request)
        principal = self.ledger._principal(kernel_peer_uid)
        if principal['workerId'] != self.worker_id:
            deny('broker_unauthorized_peer')
        db = self.ledger.db
        # Durable BEFORE any HTTP call. Never hold a SQLite transaction while
        # waiting on the remote CP; response lost => perpetual uncertainty.
        db.execute('BEGIN IMMEDIATE')
        try:
            db.execute('INSERT INTO remote_claims VALUES (?,?,?,?,?,?,?,?)', (
                req['attemptId'], req['subjectKind'], req['subjectId'], req['leaseId'],
                self.worker_id, 'pending', None, int(time.time() * 1000)))
            db.execute('COMMIT')
        except Exception as exc:
            db.execute('ROLLBACK')
            if isinstance(exc, sqlite3.IntegrityError):
                deny('broker_attempt_replay')
            raise
        try:
            response = self._reserve_cp(req)
            db.execute('BEGIN IMMEDIATE')
            try:
                cur = db.execute("UPDATE remote_claims SET status='reserved',fence_epoch=? "
                    "WHERE attempt_id=? AND status='pending'", (response['fenceEpoch'], req['attemptId']))
                if cur.rowcount != 1:
                    raise RuntimeError('lost local attempt ownership')
                db.execute('COMMIT')
            except BaseException:
                db.execute('ROLLBACK')
                raise
        except Exception:
            # Connection reset, HTTP denial, invalid result, local DB failure:
            # no automatic retry/clear. CP may have committed the durable hold.
            deny('broker_authority_uncertain')
        return {'schemaVersion': 1, 'attemptId': req['attemptId'],
                'fenceEpoch': response['fenceEpoch'], 'status': 'reserved-not-launchable',
                'canLaunch': False, 'advisoryOnly': True}

    def observe(self, kernel_peer_uid, request):
        # Query only an existing locally journaled attempt. A caller cannot
        # substitute a lease or resource identity, and a remote observation
        # MUST NOT clear or modify local uncertainty.
        if not shape(request, ('attemptId',)) or not is_id(request.get('attemptId')):
            deny('broker_invalid_message')
        principal = self.ledger._principal(kernel_peer_uid)
        if principal['workerId'] != self.worker_id:
            deny('broker_unauthorized_peer')
        row = self.ledger.db.execute(
            'SELECT subject_kind,subject_id,lease_id,worker_id,fence_epoch '
            'FROM remote_claims WHERE attempt_id=?',
            (request['attemptId'],)).fetchone()
        if row is None or row[3] != self.worker_id:
            deny('broker_attempt_unknown')
        req = {'subjectKind':row[0],'subjectId':row[1],
               'leaseId':row[2],'attemptId':request['attemptId']}
        try:
            result = self._observe_cp(req)
        except Exception:
            deny('broker_authority_uncertain')
        # If a local epoch was acknowledged, even a different remote epoch
        # is an uncertain state, NEVER permission to reuse the GPU.
        if row[4] is not None and result['fenceEpoch'] != row[4]:
            deny('broker_authority_uncertain')
        return {'schemaVersion':1,'attemptId':request['attemptId'],
                'disposition':result['disposition'],'fenceEpoch':result['fenceEpoch'],
                'canLaunch':False,'canRelease':False,'evidenceVerified':False,
                'advisoryOnly':True}

    def _observe_cp(self, req):
        body = json.dumps({'schemaVersion':1,**req},separators=(',',':'),
                          allow_nan=False).encode('utf-8')
        connection = (http.client.HTTPSConnection if self.scheme == 'https' else http.client.HTTPConnection)(
            self.hostname,self.port,timeout=1.5)
        try:
            connection.request('POST','/v1/broker/attempts/observe',body=body,
                headers={'Authorization':'Bearer '+self.token,
                         'Content-Type':'application/json','Accept':'application/json',
                         'Connection':'close'})
            resp=connection.getresponse()
            raw=resp.read(MAX_REMOTE_BODY+1)
            if resp.status!=200 or len(raw)>MAX_REMOTE_BODY:
                raise ValueError('untrusted authority observation')
            doc=strict_json(raw.decode('utf-8'))
            fields=('schemaVersion','attemptId','disposition','fenceEpoch',
                    'canLaunch','canRelease','evidenceVerified')
            if not shape(doc,('result',)) or not shape(doc['result'],fields):
                raise ValueError('invalid authority observation')
            value=doc['result']
            if type(value['schemaVersion']) is not int or value['schemaVersion']!=1 or \
               value['attemptId']!=req['attemptId'] or \
               value['disposition'] not in ('held','unconfirmed','not_found') or \
               value['canLaunch'] is not False or value['canRelease'] is not False or \
               value['evidenceVerified'] is not False or \
               not (value['fenceEpoch'] is None or
                 (type(value['fenceEpoch']) is int and 0<value['fenceEpoch']<=2**53-1)):
                raise ValueError('untrusted authority observation')
            if (value['disposition']=='not_found') != (value['fenceEpoch'] is None):
                raise ValueError('inconsistent authority observation')
            return value
        finally:
            connection.close()

    def _reserve_cp(self, req):
        body = json.dumps({'schemaVersion': 1, **req}, separators=(',', ':'), allow_nan=False).encode('utf-8')
        connection = (http.client.HTTPSConnection if self.scheme == 'https' else http.client.HTTPConnection)(
            self.hostname, self.port, timeout=1.5)
        try:
            connection.request('POST', '/v1/broker/attempts/reserve', body=body,
                headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json',
                         'Accept': 'application/json', 'Connection': 'close'})
            resp = connection.getresponse()
            # Never follow redirects. Refuse oversize/truncated or malformed body.
            raw = resp.read(MAX_REMOTE_BODY + 1)
            if resp.status != 201 or len(raw) > MAX_REMOTE_BODY:
                raise ValueError('untrusted authority response')
            result = strict_json(raw.decode('utf-8'))
            if not shape(result, ('result',)) or not shape(result['result'],
                    ('schemaVersion', 'attemptId', 'fenceEpoch', 'status', 'canLaunch')):
                raise ValueError('invalid authority result')
            value = result['result']
            if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1 or value['attemptId'] != req['attemptId'] or \
                    type(value['fenceEpoch']) is not int or not 0 < value['fenceEpoch'] <= 2**53-1 or \
                    value['status'] != 'reserved-not-launchable' or value['canLaunch'] is not False:
                raise ValueError('untrusted authority result')
            return value
        finally:
            connection.close()
