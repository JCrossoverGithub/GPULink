"""D2C: opted-in, GPU-free, fixed synthetic child provenance experiment.

Not managed OCI, not sandboxed workload execution and not release evidence.
Persist the launch *intent* before spawning. Record only a kernel-observed identity
of the locally-created, fixed Python sleep fixture. Ambiguity stays quarantined.
"""
import os
import sqlite3
import subprocess
import sys
import time

from broker_state import deny, is_id, positive, shape
from host_process_observer import BOOT_ID, _boot_id, _proc_identity, _cgroup_v2, inspect_procfs

CREATE = '''CREATE TABLE IF NOT EXISTS synthetic_probe_events (
 attempt_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence IN (1,2)),
 event TEXT NOT NULL CHECK(event IN ('intent_durable','synthetic_child_observed')),
 lease_id TEXT NOT NULL, worker_id TEXT NOT NULL,
 fence_epoch INTEGER NOT NULL CHECK(fence_epoch>0),
 boot_id TEXT, pid INTEGER, start_ticks INTEGER, cgroup_v2 TEXT,
 event_ms INTEGER NOT NULL CHECK(event_ms>0),
 PRIMARY KEY(attempt_id, sequence), UNIQUE(boot_id,pid,start_ticks),
 CHECK((sequence=1 AND event='intent_durable' AND boot_id IS NULL AND pid IS NULL
    AND start_ticks IS NULL AND cgroup_v2 IS NULL)
    OR (sequence=2 AND event='synthetic_child_observed' AND boot_id IS NOT NULL
    AND pid IS NOT NULL AND start_ticks IS NOT NULL AND cgroup_v2 IS NOT NULL))
)'''
COLUMNS=('attempt_id','sequence','event','lease_id','worker_id','fence_epoch',
         'boot_id','pid','start_ticks','cgroup_v2','event_ms')
ORIGIN='broker-created-fixed-synthetic-child-test-only'


class SyntheticProvenance:
    def __init__(self, bridge):
        self.bridge=bridge
        self.db=bridge.ledger.db
        self.db.execute(CREATE)
        for action in ('UPDATE','DELETE'):
            self.db.execute(f'''CREATE TRIGGER IF NOT EXISTS synthetic_probe_no_{action.lower()}
            BEFORE {action} ON synthetic_probe_events BEGIN
            SELECT RAISE(ABORT, 'immutable synthetic provenance event'); END''')
        # Strict restart validation: an intent without observed birth is permanently
        # uncertain, not a reason to retry launch or to declare a clean GPU.
        by_attempt={}
        for row in self.db.execute('SELECT '+','.join(COLUMNS)+' FROM synthetic_probe_events ORDER BY attempt_id,sequence'):
            self._validate_row(row)
            by_attempt.setdefault(row[0],[]).append(row)
        for attempt,rows in by_attempt.items():
            if len(rows)>2 or rows[0][1]!=1 or (len(rows)==2 and rows[1][1]!=2):
                deny('broker_provenance_corrupt')
            claim=self._claim(attempt)
            if claim is None or (rows[0][3],rows[0][4],rows[0][5])!=claim[:3]:
                deny('broker_provenance_corrupt')
            if len(rows)==2 and rows[0][3:6]!=rows[1][3:6]:
                deny('broker_provenance_corrupt')

    def _claim(self, attempt):
        return self.db.execute('SELECT lease_id,worker_id,fence_epoch,status FROM remote_claims WHERE attempt_id=?', (attempt,)).fetchone()

    @staticmethod
    def _validate_row(row):
        if (len(row)!=11 or not all(is_id(v) for v in (row[0],row[3],row[4])) or
            type(row[1]) is not int or row[1] not in (1,2) or not positive(row[5]) or
            not positive(row[10])):
            deny('broker_provenance_corrupt')
        if row[1]==1:
            if row[2]!='intent_durable' or any(v is not None for v in row[6:10]):
                deny('broker_provenance_corrupt')
        elif (row[2]!='synthetic_child_observed' or type(row[6]) is not str or not BOOT_ID.fullmatch(row[6]) or
              type(row[7]) is not int or not 1<=row[7]<=4194304 or not positive(row[8]) or
              type(row[9]) is not str or not row[9].startswith('/') or len(row[9])>1024 or
              '\x00' in row[9] or '\n' in row[9]):
            deny('broker_provenance_corrupt')

    def _authorized(self, uid, attempt):
        if not is_id(attempt):
            deny('broker_invalid_message')
        principal=self.bridge.ledger._principal(uid)
        if principal['workerId']!=self.bridge.worker_id:
            deny('broker_unauthorized_peer')
        claim=self._claim(attempt)
        if claim is None or claim[1]!=self.bridge.worker_id:
            deny('broker_attempt_unknown')
        return claim

    def spawn(self, uid, request):
        if not shape(request, ('attemptId',)):
            deny('broker_invalid_message')
        attempt=request['attemptId']
        claim=self._authorized(uid,attempt)
        if not positive(claim[2]) or claim[3]!='reserved':
            deny('broker_authority_uncertain')
        # Existing operator hints MUST NOT be upgraded to broker-launch provenance.
        if self.db.execute('SELECT 1 FROM host_identity_bindings WHERE attempt_id=?', (attempt,)).fetchone():
            deny('broker_provenance_conflict')
        if self.db.execute('SELECT 1 FROM synthetic_probe_events WHERE attempt_id=?', (attempt,)).fetchone():
            deny('broker_provenance_exists')
        remote=self.bridge.observe(uid,{'attemptId':attempt})
        if remote['disposition']!='held' or remote['fenceEpoch']!=claim[2]:
            deny('broker_authority_uncertain')
        # INTENT COMMITTED before fork/exec. A process crash between events
        # leaves only a permanent, uncertain intent. No automatic retry.
        self.db.execute('BEGIN IMMEDIATE')
        try:
            if self._claim(attempt)!=claim:
                deny('broker_authority_uncertain')
            self.db.execute('INSERT INTO synthetic_probe_events VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                (attempt,1,'intent_durable',claim[0],claim[1],claim[2],None,None,None,None,int(time.time()*1000)))
            self.db.execute('COMMIT')
        except sqlite3.IntegrityError:
            self.db.execute('ROLLBACK')
            deny('broker_provenance_exists')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise
        # Fixed, bounded NOOP: no caller-provided command, args, cwd, env, file
        # mounts, GPU access or inherited descriptors. Not a workload runtime.
        try:
            proc=subprocess.Popen([sys.executable,'-I','-S','-c','import time; time.sleep(12)'],
                stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                cwd='/', env={},close_fds=True, start_new_session=True)
            boot=_boot_id(); birth=_proc_identity(proc.pid); cgroup=_cgroup_v2(proc.pid)
            identity={'bootId':boot,'pid':proc.pid,'startTicks':birth,'cgroupV2':cgroup}
            if inspect_procfs(identity)!=('present','identity_present'):
                deny('broker_provenance_uncertain')
            self.db.execute('BEGIN IMMEDIATE')
            try:
                if self._claim(attempt)!=claim:
                    deny('broker_authority_uncertain')
                self.db.execute('INSERT INTO synthetic_probe_events VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                    (attempt,2,'synthetic_child_observed',claim[0],claim[1],claim[2],
                     boot,proc.pid,birth,cgroup,int(time.time()*1000)))
                self.db.execute('COMMIT')
            except BaseException:
                self.db.execute('ROLLBACK')
                raise
        except BaseException:
            # No rollback of the durable intent and NO automatic release or retry.
            deny('broker_provenance_uncertain')
        return {'schemaVersion':1,'attemptId':attempt,'status':'synthetic-probe-recorded',
                'origin':ORIGIN,'intentDurable':True,'identityObserved':True,
                'workloadLaunchAttested':False,'cleanupVerified':False,
                'canLaunch':False,'canRelease':False,'advisoryOnly':True}

    def observe(self, uid, request):
        if not shape(request, ('attemptId',)):
            deny('broker_invalid_message')
        attempt=request['attemptId']; claim=self._authorized(uid,attempt)
        rows=list(self.db.execute('SELECT '+','.join(COLUMNS)+
            ' FROM synthetic_probe_events WHERE attempt_id=? ORDER BY sequence',(attempt,)))
        status='no_intent'; state='unknown';reason='no_provenance_intent';source='none'
        if rows:
            for row in rows:self._validate_row(row)
            if rows[0][3:6]!=claim[:3] or len(rows)>2:
                deny('broker_provenance_corrupt')
            status='intent_uncertain';reason='birth_not_committed'
            if len(rows)==2:
                if rows[1][1]!=2 or rows[1][3:6]!=claim[:3]:
                    deny('broker_provenance_corrupt')
                status='synthetic_identity_recorded'
                state,reason=inspect_procfs({'bootId':rows[1][6],'pid':rows[1][7],
                    'startTicks':rows[1][8],'cgroupV2':rows[1][9]})
                source='linux-procfs-v1' if state!='unknown' else 'none'
        return {'schemaVersion':1,'attemptId':attempt,'status':status,'origin':ORIGIN,
                'observation':state,'reason':reason,'source':source,
                'workloadLaunchAttested':False,'authorityConfirmed':False,
                'cleanupVerified':False,'canLaunch':False,'canRelease':False,'advisoryOnly':True}
