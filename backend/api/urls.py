from django.urls import path
from .views import (
    chatgpt, 
    TextToSpeechAPIView,
    BatchTextToSpeechAPIView,
    StreamingTextToSpeechAPIView
)

urlpatterns = [
    path('chatgpt/', chatgpt),
    path('tts/', TextToSpeechAPIView.as_view(), name='text-to-speech'),
    path('tts/batch/', BatchTextToSpeechAPIView.as_view(), name='batch-text-to-speech'),
    path('tts/stream/', StreamingTextToSpeechAPIView.as_view(), name='streaming-text-to-speech'),
]
