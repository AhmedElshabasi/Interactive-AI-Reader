from django.urls import path
from .views import chatgpt

urlpatterns = [
    path('chatgpt/', chatgpt),
]
