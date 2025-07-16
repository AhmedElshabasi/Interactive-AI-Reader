# backend/api/views.py
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
import json
import os
import requests

@csrf_exempt
def chatgpt(request):
    if request.method == 'POST':
        try:
            data = json.loads(request.body)
            user_input = data.get('prompt', '')
            max_tokens = data.get('max_tokens', 1000)

            messages = [
                {
                    "role": "system",
                    "content": "You are an assistant that formats text for text-to-speech output."
                },
                {
                    "role": "user",
                    "content": user_input
                }
            ]

            response = requests.post(
                'https://api.openai.com/v1/chat/completions',
                headers={
                    'Authorization': f'Bearer {os.getenv("OPENAI_API_KEY")}',
                    'Content-Type': 'application/json'
                },
                json={
                    'model': 'gpt-4o',  # ← Use GPT-4o here
                    'messages': messages,
                    'max_tokens': max_tokens,
                    'temperature': 0.7
                }
            )

            return JsonResponse(response.json())

        except Exception as e:
            return JsonResponse({'error': str(e)}, status=500)

    return JsonResponse({'error': 'Only POST requests allowed'}, status=405)

