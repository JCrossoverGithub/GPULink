#!/usr/bin/env python3
"""GPULink B2B local Linux broker IPC conformance server.

TEST ONLY: no engine, container, GPU, launch authority or live lease provider.
The SO_PEERCRED identity and SQLite journal are real; lease records are test fixtures.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import stat
import struct
import sys
import sqlite3

from broker_state import BrokerLedger, Denied, strict_json, deny
from broker_authority_bridge import BrokerAuthorityBridge, OPERATION, OPERATION_OBSERVE
from host_process_observer import HostProcessObserver

MAX_MESSAGE = 16 * 1024
RESPONSE_MAX = 4096


def recv_exact(sock, n):
    parts = bytearray()
    while len(parts) < n:
        data = sock.recv(n-len(parts))
        if not data:
            deny('broker_truncated_message')
        parts.extend(data)
    return bytes(parts)


def recv_message(sock):
    length, = struct.unpack('>I', recv_exact(sock, 4))
    if length < 2 or length > MAX_MESSAGE:
        deny('broker_message_too_large')
    try:
        return strict_json(recv_exact(sock, length).decode('utf-8', errors='strict'))
    except UnicodeDecodeError:
        deny('broker_invalid_message')


def send_message(sock, obj):
    payload = json.dumps(obj, separators=(',',':'), ensure_ascii=True, allow_nan=False).encode('utf8')
    if len(payload) > RESPONSE_MAX:
        raise RuntimeError('unbounded broker response')
    sock.sendall(struct.pack('>I', len(payload)) + payload)


def handle_request(db, uid, request, bridge=None, host_observer=None):
    if type(request) is not dict or set(request) != {'schemaVersion','operation','payload'} or request['schemaVersion'] != 1:
        deny('broker_invalid_message')
    operation, payload = request['operation'], request['payload']
    if operation == OPERATION:
        if bridge is None:
            deny('broker_authority_disabled')
        return bridge.reserve(uid, payload)
    if operation == OPERATION_OBSERVE:
        if bridge is None:
            deny('broker_authority_disabled')
        return bridge.observe(uid, payload)
    if operation == 'observe-host':
        if host_observer is None:
            deny('broker_authority_disabled')
        return host_observer.observe(uid, payload)
    if operation == 'claim':
        if type(payload) is not dict or set(payload) != {'intent'}:
            deny('broker_invalid_message')
        return db.claim(uid, payload['intent'])
    if operation in ('inspect','cancel'):
        if type(payload) is not dict or set(payload) != {'attemptId'}:
            deny('broker_invalid_message')
        return (db.inspect if operation == 'inspect' else db.cancel)(uid, payload['attemptId'])
    deny('broker_unsupported_operation')


def serve(socket_path, db, *, stop_after=0, bridge=None, host_observer=None):
    path = Path(socket_path)
    if not path.parent.is_dir() or path.parent.is_symlink() or path.parent.stat().st_uid != os.geteuid() or path.parent.stat().st_mode & 0o077:
        deny('broker_unsafe_socket_directory')
    if path.exists() or path.is_symlink():
        deny('broker_socket_exists')
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(0.5)
    served = 0
    try:
        previous_umask = os.umask(0o177)
        try:
            sock.bind(str(path))
        finally:
            os.umask(previous_umask)
        os.chmod(path, 0o600)
        sock.listen(16)
        print('B2B_TEST_BROKER_READY', flush=True)
        while stop_after == 0 or served < stop_after:
            try:
                connection, _ = sock.accept()
            except socket.timeout:
                continue
            with connection:
                connection.settimeout(4 if bridge else 2)
                try:
                    # Linux SO_PEERCRED binds to kernel-derived peer uid, NEVER JSON claims.
                    if not hasattr(socket, 'SO_PEERCRED'):
                        deny('broker_unsupported_peer_credentials')
                    _pid, uid, _gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    response = handle_request(db, uid, recv_message(connection), bridge, host_observer)
                    send_message(connection, {'schemaVersion':1,'ok':True,'result':response})
                except (Denied, socket.timeout) as exc:
                    code = exc.code if isinstance(exc, Denied) else 'broker_timeout'
                    try:
                        send_message(connection, {'schemaVersion':1,'ok':False,'code':code})
                    except OSError:
                        pass
                except sqlite3.Error:
                    # A failed journal must never cause an execution authority fallback.
                    try:
                        send_message(connection, {'schemaVersion':1,'ok':False,'code':'broker_authority_uncertain'})
                    except OSError:
                        pass
                except (OSError, ValueError, TypeError, OverflowError):
                    try:
                        send_message(connection, {'schemaVersion':1,'ok':False,'code':'broker_invalid_message'})
                    except OSError:
                        pass
                served += 1
    finally:
        sock.close()
        if path.exists() and stat.S_ISSOCK(path.lstat().st_mode):
            path.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--test-only', action='store_true')
    parser.add_argument('--fixture', required=True)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--db', required=True)
    parser.add_argument('--stop-after', type=int, default=0)
    parser.add_argument('--authority-config', default=None)
    parser.add_argument('--host-witness-file', default=None)
    args = parser.parse_args()
    if not args.test_only or not sys.platform.startswith('linux'):
        deny('broker_test_only_linux')
    fixture_path = Path(args.fixture)
    if not fixture_path.is_file() or fixture_path.is_symlink():
        deny('broker_invalid_fixture')
    fixture = strict_json(fixture_path.read_text(encoding='utf-8'))
    ledger = BrokerLedger(args.db, fixture)
    try:
        bridge = BrokerAuthorityBridge(ledger, args.authority_config) if args.authority_config else None
        if args.host_witness_file and bridge is None:
            deny('broker_authority_disabled')
        observer = HostProcessObserver(bridge, args.host_witness_file) if bridge else None
        serve(args.socket, ledger, stop_after=args.stop_after, bridge=bridge, host_observer=observer)
    finally:
        ledger.close()

if __name__ == '__main__':
    try:
        main()
    except Denied as exc:
        print('B2B_TEST_BROKER_STOP '+exc.code, file=sys.stderr)
        raise SystemExit(2)
