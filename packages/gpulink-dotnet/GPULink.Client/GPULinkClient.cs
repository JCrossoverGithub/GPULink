using System.Net;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace GPULink.Client;

public sealed record GPULinkSessionRequest(string ProjectId, string Capability, string? Adapter = null, int MinVramMiB = 0);
public sealed record GPULinkSessionRecord(string Id, string Status);

public sealed class GPULinkApiException : Exception
{
    public GPULinkApiException(HttpStatusCode status, string code)
        : base($"GPULink API returned {(int)status} ({code})") { Status = status; Code = code; }
    public HttpStatusCode Status { get; }
    public string Code { get; }
}

/// <summary>Native client for GPULink public session HTTP API and authenticated v2 relay.</summary>
public sealed class GPULinkClient : IAsyncDisposable
{
    private readonly Uri _origin;
    private readonly string _token;
    private readonly HttpClient _http;
    private readonly bool _ownsHttp;

    public GPULinkClient(string origin, string clientBearer, HttpClient? httpClient = null)
    {
        _origin = GPULinkProtocol.ValidateOrigin(origin);
        GPULinkProtocol.ValidateBearer(clientBearer);
        _token = clientBearer;
        _ownsHttp = httpClient is null;
        _http = httpClient ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
    }

    public async Task<GPULinkSessionRecord> RequestSessionAsync(GPULinkSessionRequest request, string? idempotencyKey = null)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (string.IsNullOrWhiteSpace(request.ProjectId) || request.ProjectId.Length > 100 ||
            string.IsNullOrWhiteSpace(request.Capability) || request.Capability.Length > 100 ||
            request.MinVramMiB < 0 || request.MinVramMiB > 1_048_576 ||
            (request.Adapter is not null && (request.Adapter.Length is < 1 or > 200)))
            throw new ArgumentException("Invalid session request", nameof(request));
        if (idempotencyKey is not null && (idempotencyKey.Length is < 1 or > 200 ||
            idempotencyKey.Any(c => c < '!' || c > '~')))
            throw new ArgumentException("Invalid idempotency key", nameof(idempotencyKey));
        var payload = new {
            schemaVersion = 1,
            projectId = request.ProjectId,
            capability = request.Capability,
            requirements = new {
                gpuCount = 1,
                minVramMiB = request.MinVramMiB,
                adapter = request.Adapter
            },
            recovery = new { maxInterruptions = 0 }
        };
        using var json = await RequestAsync(HttpMethod.Post, "/v1/sessions", payload, CancellationToken.None, idempotencyKey);
        return ReadSession(json);
    }

    public async Task<GPULinkSessionRecord> GetSessionAsync(string id, CancellationToken ct = default)
    {
        using var json = await RequestAsync(HttpMethod.Get, $"/v1/sessions/{EscapeId(id)}", null, ct);
        return ReadSession(json);
    }

    public async Task CloseSessionAsync(string id, CancellationToken ct = default)
    {
        using var _ = await RequestAsync(HttpMethod.Post, $"/v1/sessions/{EscapeId(id)}/close", new { }, ct);
    }

    /// <summary>Waits for generic relay readiness; never assumes application model readiness.</summary>
    public async Task<GPULinkSession> OpenSessionAsync(
        GPULinkSessionRequest request,
        int allocationTimeoutMs = 30_000,
        int connectTimeoutMs = 8_000,
        CancellationToken ct = default)
    {
        if (allocationTimeoutMs is < 100 or > 120_000)
            throw new ArgumentOutOfRangeException(nameof(allocationTimeoutMs));
        GPULinkProtocol.ValidateConnectTimeout(connectTimeoutMs);
        ct.ThrowIfCancellationRequested();
        // Creation is deliberately non-cancellable mid-response to avoid losing the allocated ID.
        var created = await RequestSessionAsync(request);
        try
        {
            using var allocationCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            allocationCts.CancelAfter(allocationTimeoutMs);
            while (true)
            {
                allocationCts.Token.ThrowIfCancellationRequested();
                var state = await GetSessionAsync(created.Id, allocationCts.Token);
                if (state.Status is "connecting" or "active") break;
                if (state.Status is not ("requested" or "allocated" or "interrupted"))
                    throw new IOException("Session ended before worker activation");
                await Task.Delay(100, allocationCts.Token);
            }
            return await ConnectAsync(created.Id, connectTimeoutMs, allocationCts.Token);
        }
        catch (Exception error)
        {
            try { await CloseSessionAsync(created.Id); }
            catch (Exception cleanup) { throw new AggregateException("Session setup and cleanup failed", error, cleanup); }
            throw;
        }
    }

    private async Task<GPULinkSession> ConnectAsync(string id, int timeoutMs, CancellationToken ct)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeoutMs);
        var token = timeoutCts.Token;
        using var json = await RequestAsync(HttpMethod.Post,
            $"/v1/sessions/{EscapeId(id)}/data-plane/client-grant", null, token);
        var grant = json.RootElement.GetProperty("grant");
        var value = grant.GetProperty("token").GetString() ?? "";
        var expiresAt = grant.GetProperty("expiresAt").GetInt64();
        GPULinkProtocol.ValidateGrant(value, expiresAt);
        var socket = new ClientWebSocket();
        socket.Options.AddSubProtocol(GPULinkProtocol.DataPlaneV2);
        socket.Options.AddSubProtocol(GPULinkProtocol.GrantPrefix + value);
        var builder = new UriBuilder(_origin)
        {
            Scheme = _origin.Scheme == Uri.UriSchemeHttps ? "wss" : "ws",
            Path = "/v1/data-plane",
            Query = "",
            Fragment = ""
        };
        try
        {
            try { await socket.ConnectAsync(builder.Uri, token); }
            catch (Exception) when (!ct.IsCancellationRequested && !token.IsCancellationRequested)
            {
                throw new IOException("GPULink WebSocket authentication/handshake failed");
            }
            if (socket.SubProtocol != GPULinkProtocol.DataPlaneV2)
                throw new IOException("GPULink WebSocket protocol mismatch; downgrade prohibited");

            var early = new Queue<GPULinkMessage>();
            long earlyBytes = 0;
            while (true)
            {
                token.ThrowIfCancellationRequested();
                var frame = await GPULinkSocket.ReadFrameAsync(socket, token);
                if (!frame.IsBinary && frame.Text == GPULinkProtocol.RelayReadyV2) break;
                earlyBytes += frame.Payload.Length;
                if (early.Count >= GPULinkProtocol.MaxEarlyFrames || earlyBytes > GPULinkProtocol.MaxBufferedBytes)
                    throw new InvalidDataException("Pre-readiness GPULink buffer limit exceeded");
                early.Enqueue(frame);
            }
            // Ownership passes to GPULinkSession; do not dispose this socket here.
            return new GPULinkSession(id, socket, early, () => CloseSessionAsync(id));
        }
        catch
        {
            socket.Abort();
            socket.Dispose();
            throw;
        }
    }


    private async Task<JsonDocument> RequestAsync(HttpMethod method, string relative, object? payload, CancellationToken ct, string? idempotencyKey = null)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(15_000);
        using var req = new HttpRequestMessage(method, new Uri(_origin, relative));
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (idempotencyKey is not null) req.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);
        if (payload is not null)
            req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var response = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if ((int)response.StatusCode is >= 300 and < 400)
            throw new IOException("GPULink API redirect is prohibited");
        await response.Content.LoadIntoBufferAsync(1_048_576, timeout.Token);
        var body = await response.Content.ReadAsStringAsync(timeout.Token);
        using var json = JsonDocument.Parse(body);
        if (!response.IsSuccessStatusCode)
        {
            string code = "http_error";
            if (json.RootElement.TryGetProperty("error", out var e) &&
                e.ValueKind == JsonValueKind.Object && e.TryGetProperty("code", out var c) &&
                c.ValueKind == JsonValueKind.String)
                code = c.GetString() ?? "http_error";
            throw new GPULinkApiException(response.StatusCode, code);
        }
        if (json.RootElement.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Invalid GPULink JSON envelope");
        return JsonDocument.Parse(body);
    }

    private static GPULinkSessionRecord ReadSession(JsonDocument json)
    {
        var session = json.RootElement.GetProperty("session");
        var id = session.GetProperty("id").GetString();
        var status = session.GetProperty("status").GetString();
        if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(status))
            throw new InvalidDataException("Invalid GPULink session record");
        return new GPULinkSessionRecord(id, status);
    }

    private static string EscapeId(string id)
    {
        if (string.IsNullOrWhiteSpace(id) || id.Length > 256)
            throw new ArgumentException("Invalid session ID", nameof(id));
        return Uri.EscapeDataString(id);
    }

    public ValueTask DisposeAsync()
    {
        if (_ownsHttp) _http.Dispose();
        return ValueTask.CompletedTask;
    }
}
