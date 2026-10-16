"""D2B: irreversible test-only broker-measured /proc identity ledger.

This captures a kernel observation of an *operator-hinted* existing process.
It is NOT evidence of GPULink launch provenance, GPU cleanup, or permission to
release a control-plane fence. A genuine launch attestation needs a future
broker-owned runtime lifecycle and isolated workload identity.
"""
import sqlite3
import time

from broker_state import deny, is_id, positive, shape
from host_process_observer import BOOT_ID, inspect_procfs

CREATE = '''CREATE TABLE IF NOT EXISTS host_identity_bindings (
    attempt_id TEXT PRIMARY KEY NOT NULL,
    lease_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    fence_epoch INTEGER NOT NULL CHECK(fence_epoch > 0),
    boot_id TEXT NOT NULL,
    pid INTEGER NOT NULL CHECK(pid > 0),
    start_ticks INTEGER NOT NULL CHECK(start_ticks > 0),
    cgroup_v2 TEXT NOT NULL,
    captured_ms INTEGER NOT NULL CHECK(captured_ms > 0),
    origin TEXT NOT NULL CHECK(origin='operator-hint-procfs-test-only'),
    UNIQUE(boot_id,pid,start_ticks)
)'''
COLUMNS = ('attempt_id','lease_id','worker_id','fence_epoch','boot_id','pid',
           'start_ticks','cgroup_v2','captured_ms','origin')

class HostBindingJournal:
    """A local host identity is immutable, never an authoritative launch grant."""
    def __init__(self, observer):
        self.observer = observer
        self.bridge = observer.bridge
        db = self.bridge.ledger.db
        db.execute(CREATE)
        # Prevent unintended mutation by this process or ordinary SQL clients.
        # A privileged host compromise / SQLite schema rewrite is out of scope.
        db.execute('''CREATE TRIGGER IF NOT EXISTS host_binding_no_update
            BEFORE UPDATE ON host_identity_bindings BEGIN
            SELECT RAISE(ABORT, 'immutable host binding'); END''')
        db.execute('''CREATE TRIGGER IF NOT EXISTS host_binding_no_delete
            BEFORE DELETE ON host_identity_bindings BEGIN
            SELECT RAISE(ABORT, 'immutable host binding'); END''')
        # Fail closed on malformed preexisting journal. Never silently erase it.
        for row in db.execute('SELECT '+','.join(COLUMNS)+' FROM host_identity_bindings'):
            self._validate(row)
            claim = self._claim(row[0])
            if claim is None or (claim[0],claim[1],claim[2])!=(row[1],row[2],row[3]):
                deny('broker_binding_corrupt')

    def _claim(self, attempt_id):
        return self.bridge.ledger.db.execute(
            'SELECT lease_id,worker_id,fence_epoch,status FROM remote_claims WHERE attempt_id=?',
            (attempt_id,)).fetchone()

    @staticmethod
    def _validate(row):
        if (len(row)!=10 or not all(is_id(x) for x in (row[0],row[1],row[2])) or
            not positive(row[3]) or type(row[4]) is not str or not BOOT_ID.fullmatch(row[4]) or
            type(row[5]) is not int or not 1<=row[5]<=4194304 or not positive(row[6]) or
            type(row[7]) is not str or not row[7].startswith('/') or len(row[7])>1024 or
            '\x00' in row[7] or '\n' in row[7] or not positive(row[8]) or
            row[9]!='operator-hint-procfs-test-only'):
            deny('broker_binding_corrupt')

    def _authorized(self, uid, attempt_id):
        if not is_id(attempt_id):
            deny('broker_invalid_message')
        principal=self.bridge.ledger._principal(uid)
        if principal['workerId']!=self.bridge.worker_id:
            deny('broker_unauthorized_peer')
        claim=self._claim(attempt_id)
        if claim is None or claim[1]!=self.bridge.worker_id:
            deny('broker_attempt_unknown')
        return claim

    def capture(self, peer_uid, request):
        if not shape(request, ('attemptId',)):
            deny('broker_invalid_message')
        attempt_id=request.get('attemptId')
        claim=self._authorized(peer_uid,attempt_id)
        if not positive(claim[2]) or claim[3] not in ('reserved','quarantined'):
            deny('broker_authority_uncertain')
        witness=self.observer.witnesses.get(attempt_id)
        if witness is None:
            deny('broker_binding_witness_missing')
        if (witness['leaseId'],witness['workerId'],witness['fenceEpoch'])!=claim[:3]:
            deny('broker_binding_identity_mismatch')
        # Query the authoritative CP before persisting a hint. A successful
        # observation DOES NOT grant a running-process identity or release right.
        # Avoid a CP read for an already-bound attempt. It must not
        # change journal state or make another HTTP attempt on replay.
        if self.bridge.ledger.db.execute(
            'SELECT 1 FROM host_identity_bindings WHERE attempt_id=?',
            (attempt_id,)).fetchone():
            deny('broker_binding_exists')
        observation=self.bridge.observe(peer_uid,{'attemptId':attempt_id})
        if observation['disposition']!='held' or observation['fenceEpoch']!=claim[2]:
            deny('broker_authority_uncertain')
        state,_=inspect_procfs(witness)
        if state!='present':
            deny('broker_binding_host_unconfirmed')
        db=self.bridge.ledger.db
        # A single-writer journal transaction protects against attempts being
        # rebound (even to identical hints) or a cross-attempt PID alias.
        db.execute('BEGIN IMMEDIATE')
        try:
            if self._claim(attempt_id)!=claim:
                deny('broker_authority_uncertain')
            db.execute('INSERT INTO host_identity_bindings VALUES (?,?,?,?,?,?,?,?,?,?)',(
                attempt_id,claim[0],claim[1],claim[2],witness['bootId'],witness['pid'],
                witness['startTicks'],witness['cgroupV2'],int(time.time()*1000),
                'operator-hint-procfs-test-only'))
            db.execute('COMMIT')
        except sqlite3.IntegrityError:
            db.execute('ROLLBACK')
            deny('broker_binding_exists')
        except BaseException:
            db.execute('ROLLBACK')
            raise
        return {'schemaVersion':1,'attemptId':attempt_id,'status':'captured-test-only',
                'brokerMeasured':True,'launchAttested':False,'cleanupVerified':False,
                'canLaunch':False,'canRelease':False,'advisoryOnly':True}

    def observe(self, peer_uid, request):
        if not shape(request, ('attemptId',)):
            deny('broker_invalid_message')
        attempt_id=request.get('attemptId')
        claim=self._authorized(peer_uid,attempt_id)
        row=self.bridge.ledger.db.execute('SELECT '+','.join(COLUMNS)+
            ' FROM host_identity_bindings WHERE attempt_id=?',(attempt_id,)).fetchone()
        state,reason,source='unknown','no_durable_binding','none'
        if row is not None:
            self._validate(row)
            if (row[1],row[2],row[3])!=(claim[0],claim[1],claim[2]):
                deny('broker_binding_corrupt')
            state,reason=inspect_procfs({'bootId':row[4], 'pid':row[5],
                'startTicks':row[6],'cgroupV2':row[7]})
            if state!='unknown':
                source='linux-procfs-v1'
        # This is local-only observation, intentionally NOT proof that remote
        # authority is still held or that the GPU is free.
        return {'schemaVersion':1,'attemptId':attempt_id,'observation':state,
            'reason':reason,'source':source,'brokerMeasured':row is not None,
            'launchAttested':False,'authorityConfirmed':False,
            'cleanupVerified':False,'canLaunch':False,'canRelease':False,
            'advisoryOnly':True}
