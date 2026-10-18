using System.Net.WebSockets;
using System.Text;

namespace GPULink.Client;

public sealed record GPULinkMessage(bool IsBinary, ReadOnlyMemory<byte> Payload)
{
    public string Text => !IsBinary
        ? new UTF8Encoding(false, true).GetString(Payload.Span)
        : throw new InvalidOperationException("Binary frames cannot be decoded as text");
}

/// <summary>Generic transport session. Socket admission does not imply workload consumption.</summary>
public sealed class GPULinkSession : IAsyncDisposable
{
    private readonly ClientWebSocket _socket;
    private readonly Func<Task> _release;
    private readonly Queue<GPULinkMessage> _early;
    private readonly SemaphoreSlim _sending = new(1, 1);
    private readonly SemaphoreSlim _receiving = new(1, 1);
    private readonly object _closeSync = new();
    private Task? _closeTask;
    private bool _closing;

    internal GPULinkSession(string id, ClientWebSocket socket, Queue<GPULinkMessage> early, Func<Task> release)
    {
        Id = id;
        _socket = socket;
        _early = early;
        _release = release;
    }

    public string Id { get; }
    public bool IsOpen => !_closing && _socket.State == WebSocketState.Open;

    public Task SendBinaryAsync(ReadOnlyMemory<byte> message, CancellationToken cancellationToken = default)
        => SendAsync(message, WebSocketMessageType.Binary, cancellationToken);

    public Task SendTextAsync(string message, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(message);
        if (message == GPULinkProtocol.RelayReadyV2)
            throw new InvalidOperationException("Reserved relay control message cannot be sent");
        return SendAsync(Encoding.UTF8.GetBytes(message), WebSocketMessageType.Text, cancellationToken);
    }

    private async Task SendAsync(ReadOnlyMemory<byte> message, WebSocketMessageType kind, CancellationToken ct)
    {
        GPULinkProtocol.ValidateFrameLength(message.Length);
        if (!IsOpen) throw new InvalidOperationException("Data plane is not open");
        // Reject concurrent sends instead of accumulating an unbounded backlog.
        if (!await _sending.WaitAsync(0, ct).ConfigureAwait(false))
            throw new InvalidOperationException("Another data-plane send is in progress");
        try
        {
            if (!IsOpen) throw new InvalidOperationException("Data plane is closing");
            await _socket.SendAsync(message, kind, true, ct).ConfigureAwait(false);
        }
        finally { _sending.Release(); }
    }

    public async Task<GPULinkMessage> ReceiveAsync(CancellationToken cancellationToken = default)
    {
        if (!await _receiving.WaitAsync(0, cancellationToken).ConfigureAwait(false))
            throw new InvalidOperationException("Concurrent reads are not allowed");
        try
        {
            if (_closing) throw new InvalidOperationException("Data plane is closing");
            var frame = _early.Count > 0
                ? _early.Dequeue()
                : await GPULinkSocket.ReadFrameAsync(_socket, cancellationToken).ConfigureAwait(false);
            if (!frame.IsBinary && frame.Text == GPULinkProtocol.RelayReadyV2)
            {
                await CloseAsync().ConfigureAwait(false);
                throw new InvalidOperationException("Duplicate relay readiness control received");
            }
            return frame;
        }
        catch (WebSocketException)
        {
            await CloseAsync().ConfigureAwait(false);
            throw new IOException("GPULink data plane interrupted");
        }
        catch (EndOfStreamException)
        {
            await CloseAsync().ConfigureAwait(false);
            throw;
        }
        catch (InvalidDataException)
        {
            await CloseAsync().ConfigureAwait(false);
            throw;
        }
        catch (DecoderFallbackException)
        {
            await CloseAsync().ConfigureAwait(false);
            throw;
        }
        finally { _receiving.Release(); }
    }

    /// <summary>Releases the authoritative session even if the socket was already closed.</summary>
    public Task CloseAsync()
    {
        lock (_closeSync)
        {
            _closing = true;
            _socket.Abort();
            return _closeTask ??= ReleaseAsync();
        }
    }

    private async Task ReleaseAsync()
    {
        try
        {
            await _release().ConfigureAwait(false);
        }
        catch
        {
            lock (_closeSync) _closeTask = null; // Explicit retry permitted.
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        try { await CloseAsync().ConfigureAwait(false); }
        finally { _socket.Dispose(); }
    }
}

internal static class GPULinkSocket
{
    public static async Task<GPULinkMessage> ReadFrameAsync(ClientWebSocket socket, CancellationToken ct)
    {
        byte[] buffer = new byte[16_384];
        using var output = new MemoryStream();
        WebSocketMessageType? type = null;
        while (true)
        {
            var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), ct).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
                throw new EndOfStreamException("GPULink data plane closed without workload completion");
            if (type is not null && type != result.MessageType)
                throw new InvalidDataException("Data-plane frame type changed across fragments");
            type = result.MessageType;
            if (result.Count > GPULinkProtocol.MaxFrameBytes - output.Length)
                throw new InvalidDataException("GPULink data-plane frame exceeded limit");
            output.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                bool binary = type == WebSocketMessageType.Binary;
                var bytes = output.ToArray();
                if (!binary) _ = new UTF8Encoding(false, true).GetString(bytes);
                return new GPULinkMessage(binary, bytes);
            }
        }
    }
}
