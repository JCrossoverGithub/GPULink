using System.Text;
using System.Text.RegularExpressions;

namespace GPULink.Client;

/// <summary>Generic GPULink public API wire rules; no workload semantics.</summary>
public static partial class GPULinkProtocol
{
    public const string DataPlaneV2 = "gpulink.data-plane.v2";
    public const string RelayReadyV2 = "gpulink.relay.ready.v2";
    public const string GrantPrefix = "gpulink.grant.";
    public const int MaxFrameBytes = 1_048_576;
    public const int MaxBufferedBytes = 4_194_304;
    public const int MaxEarlyFrames = 256;

    [GeneratedRegex(@"^gdp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex GrantPattern();

    public static Uri ValidateOrigin(string baseUrl)
    {
        if (string.IsNullOrWhiteSpace(baseUrl) ||
            !Uri.TryCreate(baseUrl, UriKind.Absolute, out var origin))
            throw new ArgumentException("GPULink origin must be absolute", nameof(baseUrl));

        var loopback = origin.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || origin.Host == "127.0.0.1" || origin.Host == "::1";
        if (origin.Scheme != Uri.UriSchemeHttps && !(origin.Scheme == Uri.UriSchemeHttp && loopback))
            throw new ArgumentException("HTTPS is required outside loopback", nameof(baseUrl));
        if (!string.IsNullOrEmpty(origin.UserInfo) ||
            !string.IsNullOrEmpty(origin.Query) || !string.IsNullOrEmpty(origin.Fragment) ||
            origin.AbsolutePath != "/")
            throw new ArgumentException("Origin must not include credentials, path, query or fragment", nameof(baseUrl));
        return origin;
    }

    public static void ValidateBearer(string token)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 4096 ||
            token.Any(c => c < '!' || c > '~'))
            throw new ArgumentException("Invalid bearer token");
    }

    public static void ValidateGrant(string token, long expiresAt)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 4096 ||
            !GrantPattern().IsMatch(token) || expiresAt <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            throw new InvalidOperationException("Invalid or expired data-plane grant");
    }

    public static void ValidateFrameLength(int length)
    {
        if (length < 0 || length > MaxFrameBytes)
            throw new ArgumentOutOfRangeException(nameof(length), "Data-plane frame exceeds 1 MiB");
    }

    public static void ValidateConnectTimeout(int milliseconds)
    {
        if (milliseconds < 100 || milliseconds > 10_000)
            throw new ArgumentOutOfRangeException(nameof(milliseconds), "Connect timeout must be 100..10000ms");
    }

    public static int TextBytes(string value) => Encoding.UTF8.GetByteCount(value);
}
