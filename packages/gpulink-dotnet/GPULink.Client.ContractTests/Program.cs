using GPULink.Client;
using System.Net;
using System.Text;
using System.Text.Json;

var passed = 0;
void Check(string name, Action action)
{
    action();
    Console.WriteLine("PASS: " + name);
    passed++;
}
async Task AsyncCheck(string name, Func<Task> action)
{
    await action();
    Console.WriteLine("PASS: " + name);
    passed++;
}
void Reject<T>(Action action) where T : Exception
{
    try { action(); }
    catch (T) { return; }
    throw new Exception("Expected " + typeof(T).Name);
}

Check("HTTPS origin", () => { _ = GPULinkProtocol.ValidateOrigin("https://gpu.example.org/"); });
Check("loopback HTTP origin", () => { _ = GPULinkProtocol.ValidateOrigin("http://127.0.0.1:4321/"); });
Check("reject remote HTTP", () => Reject<ArgumentException>(() => GPULinkProtocol.ValidateOrigin("http://gpu.example.org/")));
Check("reject origin credentials", () => Reject<ArgumentException>(() => GPULinkProtocol.ValidateOrigin("https://user:pass@gpu.example.org/")));
Check("reject origin query", () => Reject<ArgumentException>(() => GPULinkProtocol.ValidateOrigin("https://gpu.example.org/?token=x")));
Check("reject origin path", () => Reject<ArgumentException>(() => GPULinkProtocol.ValidateOrigin("https://gpu.example.org/other")));
Check("reject bearer whitespace", () => Reject<ArgumentException>(() => GPULinkProtocol.ValidateBearer("abc\nsecret")));
Check("reject malformed grant", () => Reject<InvalidOperationException>(() => GPULinkProtocol.ValidateGrant("arbitrary", long.MaxValue)));
Check("reject expired grant", () => Reject<InvalidOperationException>(() => GPULinkProtocol.ValidateGrant("gdp1.aaa.bbb", 1)));
Check("valid grant", () => GPULinkProtocol.ValidateGrant("gdp1.aaa.bbb", long.MaxValue));
Check("frame maximum", () => GPULinkProtocol.ValidateFrameLength(1_048_576));
Check("frame overflow", () => Reject<ArgumentOutOfRangeException>(() => GPULinkProtocol.ValidateFrameLength(1_048_577)));
Check("connect timeout bounds", () => Reject<ArgumentOutOfRangeException>(() => GPULinkProtocol.ValidateConnectTimeout(10_001)));
Check("v2 control constants", () =>
{
    if (GPULinkProtocol.DataPlaneV2 != "gpulink.data-plane.v2" ||
        GPULinkProtocol.RelayReadyV2 != "gpulink.relay.ready.v2") throw new Exception("Control mismatch");
});

var handler = new FakeHandler(req =>
{
    if (req.RequestUri?.AbsolutePath == "/v1/sessions" && req.Method == HttpMethod.Post)
        return Json("{\"session\":{\"id\":\"session_abc\",\"status\":\"requested\"},\"duplicate\":false}");
    if (req.RequestUri?.AbsolutePath == "/v1/sessions/session_abc" && req.Method == HttpMethod.Get)
        return Json("{\"session\":{\"id\":\"session_abc\",\"status\":\"closed\"}}");
    if (req.RequestUri?.AbsolutePath == "/v1/sessions/session_abc/close" && req.Method == HttpMethod.Post)
        return Json("{\"session\":{\"id\":\"session_abc\",\"status\":\"closed\"}}");
    throw new Exception("Unexpected path");
});
await using var client = new GPULinkClient("http://127.0.0.1:9999/", "test-client-only", new HttpClient(handler));
await AsyncCheck("POST session with client credential and generic adapter", async () =>
{
    var response = await client.RequestSessionAsync(new("project_test", "speech.streaming.multitalker", "captionlink.adapter", 8192));
    if (response.Id != "session_abc") throw new Exception("Session response mismatch");
    using var request = JsonDocument.Parse(handler.RequestBodies[0]);
    var body = request.RootElement;
    if (body.GetProperty("capability").GetString() != "speech.streaming.multitalker" ||
        body.GetProperty("requirements").GetProperty("adapter").GetString() != "captionlink.adapter")
        throw new Exception("Generic request shape mismatch");
    if (handler.AuthHeaders[0] != "Bearer test-client-only") throw new Exception("Missing client auth");
});
await AsyncCheck("GET session state", async () =>
{
    var response = await client.GetSessionAsync("session_abc");
    if (response.Status != "closed") throw new Exception("Unexpected state");
});
await AsyncCheck("POST close session", () => client.CloseSessionAsync("session_abc"));
await AsyncCheck("openSession aborts and releases closed allocation", async () =>
{
    var closedBefore = handler.RequestPaths.Count(p => p == "/v1/sessions/session_abc/close");
    try { await client.OpenSessionAsync(new("project_test", "speech.streaming")); }
    catch (IOException) { }
    var closedAfter = handler.RequestPaths.Count(p => p == "/v1/sessions/session_abc/close");
    if (closedAfter != closedBefore + 1)
        throw new Exception("Setup failure did not close authoritative session exactly once");
});
Check("rejected idempotency-key whitespace", () =>
{
    Reject<ArgumentException>(() => client.RequestSessionAsync(new("project_test", "speech.streaming"), "bad key").GetAwaiter().GetResult());
});
Console.WriteLine($"PASS: {passed} generic .NET SDK contract checks (no network WebSocket or physical GPU)");

static HttpResponseMessage Json(string json) => new(HttpStatusCode.OK)
{
    Content = new StringContent(json, Encoding.UTF8, "application/json")
};

sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> route) : HttpMessageHandler
{
    public List<string> RequestBodies { get; } = [];
    public List<string> AuthHeaders { get; } = [];
    public List<string> RequestPaths { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        RequestPaths.Add(request.RequestUri!.AbsolutePath);
        AuthHeaders.Add(request.Headers.Authorization?.ToString() ?? "");
        if (request.Content is not null) RequestBodies.Add(await request.Content.ReadAsStringAsync(cancellationToken));
        return route(request);
    }
}
