import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useConfig } from '../lib/api';
import { API_URL } from '../lib/config';
import { useTheme } from '../lib/theme';

/**
 * Cloudflare Turnstile inside a WebView. The page is loaded with baseUrl = API_URL, so the
 * site key's allowed hostnames must include the API host in staging/production.
 * Tokens are single-use: change `resetKey` to get a fresh widget after each submit.
 */
export function Turnstile({
  onToken,
  resetKey,
}: {
  onToken: (token: string | null) => void;
  resetKey: number;
}) {
  const { data: config } = useConfig();
  const { dark } = useTheme();
  if (!config?.turnstileSiteKey) return <View style={{ height: 70 }} />;

  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:transparent;display:flex;justify-content:center}</style>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTsLoad&render=explicit" async defer></script>
</head><body><div id="w"></div><script>
function send(t){window.ReactNativeWebView.postMessage(JSON.stringify({token:t}))}
function onTsLoad(){turnstile.render('#w',{sitekey:${JSON.stringify(config.turnstileSiteKey)},theme:${JSON.stringify(dark ? 'dark' : 'light')},
callback:function(t){send(t)},'expired-callback':function(){send(null)},'error-callback':function(){send(null)}})}
</script></body></html>`;

  return (
    <View style={{ height: 70 }}>
      <WebView
        key={resetKey}
        originWhitelist={['*']}
        source={{ html, baseUrl: API_URL }}
        style={{ backgroundColor: 'transparent' }}
        javaScriptEnabled
        scrollEnabled={false}
        onMessage={(e) => {
          try {
            const { token } = JSON.parse(e.nativeEvent.data) as { token: string | null };
            onToken(token);
          } catch {
            onToken(null);
          }
        }}
      />
    </View>
  );
}
